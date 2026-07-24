// Tab View visualization plugin — renders arrangements as
// scrolling tablature via alphaTab (https://alphatab.net/).
//
// The tab is built directly from the renderer bundle (bundle.notes/
// .chords/.tuning/.stringCount/.beats — see src/chart-quantize.js and
// src/score-builder.js) instead
// of fetching a server-converted Guitar Pro file. bundle.notes/.chords/
// .tuning/.stringCount are already the EFFECTIVE, chart-transform-applied
// chart (highway.js stages any registered transform before building the
// bundle), so any prior plugin that remaps notes/strings/tuning reaches
// the tab automatically, and building straight from bundle also drops
// GP5's hard 7-string cap (alphaTab's own model has no string-count
// ceiling).
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption (one alphaTab API, one container, one
// cursor highlight, one set of fetch sentinels). Wave C lifts that:
// every piece of per-render state moves into createFactory closures
// so N tabview instances coexist under splitscreen panels.
//
// Module-scope retained for genuine singletons:
//   - alphaTab CDN script load (one <script> tag per tab)
//
// Tabview has no MIDI input and no focus-driven behavior — every
// panel renders independently from its own bundle.currentTime, and
// the splitscreen helper is consulted only for the mount target via
// panelChromeFor(). Absence of window.slopsmithSplitscreen OR
// isActive()===false means "main-player, mount into #player."
//
// alphaTab multi-instance: alphaTab loads its font + soundfont as
// CDN-cached static resources, so N AlphaTabApi instances on the
// same page share the underlying assets without coordination. Each
// instance owns its own AlphaTabApi + its own scoreLoaded /
// renderFinished / error subscriptions.

import { buildScoreFromBundle } from './src/score-builder.js';

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Module-level state (singletons)
// ═══════════════════════════════════════════════════════════════════════

// Monotonic id for per-instance DOM tagging (containers, alphaTab
// mount divs, highlight overlays, error banners — every node a
// tabview instance creates is suffixed with this so N instances
// don't collide on getElementById.
let _nextInstanceId = 0;

// ═══════════════════════════════════════════════════════════════════════
// alphaTab CDN loader (memoized — one load per page)
// ═══════════════════════════════════════════════════════════════════════

// Pin alphaTab to a specific release so new jsDelivr cache invalidations
// or upstream breaking changes can't land silently in production. Bump
// this when the alphaTab CDN publishes a version tested against the
// cursor-sync / tab-highlight behavior below. Keep in sync with
// package.json's @coderline/alphatab devDependency (used to test
// src/score-builder.js against the real model classes).
const ALPHATAB_VERSION = '1.8.2';
const ALPHATAB_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@' + ALPHATAB_VERSION + '/dist';

// alphaTab's internal MIDI tick resolution (ticks per quarter note) —
// confirmed fixed at 960 (MidiUtils.QuarterTime). Bar 1 starts at tick 0.
const TICKS_PER_BEAT = 960;

let _alphaTabLoadPromise = null;
function _tvLoadScript() {
    if (window.alphaTab) return Promise.resolve();
    if (_alphaTabLoadPromise) return _alphaTabLoadPromise;
    _alphaTabLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ALPHATAB_CDN_BASE + '/alphaTab.min.js';
        s.onload = resolve;
        s.onerror = () => {
            _alphaTabLoadPromise = null;  // allow retry on next init
            reject(new Error('Failed to load alphaTab'));
        };
        document.head.appendChild(s);
    });
    return _alphaTabLoadPromise;
}

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrapper
// ═══════════════════════════════════════════════════════════════════════
//
// Tabview only needs panelChromeFor() — there's no MIDI routing or
// focus-driven behavior. Validate ONLY that surface so a partial
// helper that lacks the focus-related methods (which tabview doesn't
// consume) still routes through the splitscreen mount target.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    return typeof ss.panelChromeFor === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return ss.panelChromeFor(highwayCanvas);
}

// Resolve the DOM mount target for tabview's container / error banner.
// Splitscreen-active: ONLY the panel chrome is acceptable; if
// panelChromeFor returns null mid-creation or during a screen
// transition, return null so callers treat the mount as unavailable
// (the container won't be cached, and a later draw() / resize() /
// banner attempt retries cleanly once the panel chrome resolves).
// Falling through to #player here would (a) cache _tvContainer
// against the main player surface for the rest of the instance's
// lifetime, rendering this panel's tabs over the wrong area, and
// (b) confuse _tvSizeContainer's splitscreen vs main-player branch
// since _ssActive() would still be true on subsequent calls.
function _resolveMount(highwayCanvas) {
    if (_ssActive()) {
        return _ssPanelChrome(highwayCanvas);
    }
    return document.getElementById('player');
}

// ═══════════════════════════════════════════════════════════════════════
// Cursor sync helpers (stateless — beats come from the bundle)
// ═══════════════════════════════════════════════════════════════════════

// Count of leading elements (arr sorted ascending by keyFn) with
// keyFn(el) <= target — i.e. the first index where that stops holding.
// "Largest index with keyFn <= target" is one less than this, which is
// exactly what both call sites below want (verified equivalent to their
// original bounded/unbounded binary searches against 17k+ randomized
// cases). highway.js exposes an equivalent (bundle.lowerBoundTime) for
// .time-keyed arrays, but that's a per-bundle helper and single-player
// mode's cursor loop (_tvCursorLoop) has no bundle — only
// window.highway.getBeats() — so this file needs its own bundle-independent
// search; sharing ONE implementation between the two call sites here at
// least avoids a second hand-rolled copy on top of that.
function _countLE(arr, target, keyFn) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keyFn(arr[mid]) <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function _tvTimeToTick(seconds, beats) {
    if (!beats || beats.length < 2) return 0;
    if (seconds < beats[0].time) return 0;

    // Largest idx in [0, beats.length-2] with beats[idx].time <= seconds.
    const count = _countLE(beats, seconds, b => b.time);
    const idx = Math.min(count - 1, beats.length - 2);

    let frac = 0;
    if (idx < beats.length - 1) {
        const bStart = beats[idx].time;
        const bEnd = beats[idx + 1].time;
        if (bEnd > bStart) {
            frac = Math.min(1, Math.max(0, (seconds - bStart) / (bEnd - bStart)));
        }
    }

    return Math.round((idx + frac) * TICKS_PER_BEAT);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // alphaTab + DOM state (per-instance)
    let _tvApi = null;           // persists across chart rebuilds — see _tvInitAlphaTab
    let _tvUnsubscribe = null;   // current render's [off, off, off] from _tvApi's .on() calls
    let _tvContainer = null;
    let _tvAtMount = null;       // inner <div> alphaTab renders into
    let _tvHighlight = null;     // cursor highlight overlay element
    let _tvErrorBanner = null;   // current error banner element (if any)
    let _tvErrorBannerTimeout = null;
    let _tvReady = false;

    // Highway canvas swap state
    let _tvHighwayCanvas = null;
    let _tvPrevVisibility = '';

    // Mount position restore — when _tvCreateContainer() promotes a static
    // mount to position:relative it saves the original inline style here so
    // _tvRemoveContainer() can put it back on teardown.
    let _tvPrevMountPosition = null;

    // Observes #player-controls so the overlay re-insets when the controls
    // bar wraps to a second row on narrow viewports (slopsmith#336). The
    // window-resize listener only fires for viewport changes; this catches
    // content reflow within an unchanged viewport. Main-player mode only —
    // splitscreen panel chrome owns its own bottom-bar layout.
    let _tvControlsObserver = null;

    // Chart tracking — keyed on bundle.notes IDENTITY, not song/arrangement
    // fields. highway.js restages a fresh notes array reference every time
    // the effective chart changes (song load, mastery slider move, or a
    // chart-transform provider rerunning — toggle, capo/octave tweak, etc.),
    // so a reference change is exactly "rebuild the tab", independent of why.
    let _tvCurrentNotesRef = null;  // notes ref the currently-rendered score reflects
    let _tvPendingNotesRef = null;  // notes ref a render is currently in flight for
    let _tvFailedNotesRef = null;   // notes ref that last failed (avoid a per-frame retry storm)

    // Cursor sync
    let _tvLastTick = -9999;  // far below any real tick (0 is now a valid position)

    // Self-driven cursor rAF handle (slopsmith#734 follow-up). In
    // single-player the marker is advanced from our OWN requestAnimationFrame
    // loop, not the host draw() pump — see _tvCursorLoop for why.
    let _tvCursorRAF = null;

    // Marker positioning (slopsmith#734). We render our OWN playback
    // marker from alphaTab's layout geometry instead of relying on
    // alphaTab's internal player cursor (.at-cursor-bar). That cursor
    // only appears once alphaTab's *player* reaches the "ready" state,
    // which requires the soundfont to download from the CDN — fragile
    // in the desktop shell (the cursor silently vanished in 0.2.9-beta.2).
    // We don't use alphaTab's synth at all (slopsmith drives audio), so
    // the player is disabled and the marker is driven by boundsLookup,
    // which is available from layout alone (core.includeNoteBounds).
    //
    // _tvAtBeats: flat [{ beat, start }] for every rhythmic beat in the
    // loaded score, sorted by absoluteDisplayStart (960-ppq MIDI ticks,
    // bar 0 beat 0 == tick 0). Rebuilt on each scoreLoaded.
    // _tvLastBeat: the alphaTab Beat the marker currently sits on — kept
    // so a resize (which re-lays-out and rebuilds boundsLookup) can
    // re-place the marker without waiting for the next time tick.
    let _tvAtBeats = [];
    let _tvLastBeat = null;

    // Latest beats snapshot — bundle.beats is the source of truth
    // under Wave C (the bare `highway` global used in Wave B was the
    // main-player's highway, not ours under splitscreen).
    let _tvLatestBeats = null;

    // Monotonic init counter. Each init() bumps it; async continuations
    // (CDN script load, alphaTab's own render pipeline) capture the token
    // and bail if a newer init/render has started since — guards a rapid
    // arrangement/transform switch from installing a stale score over a
    // newer one.
    let _tvInitToken = 0;

    // ── Listener ref (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _tvSizeContainer();

    // Tell the core highway whether its canvas is currently covered by the
    // tab view. We hide the host canvas with visibility:hidden (so alphaTab
    // can still measure its width), but visibility:hidden doesn't trip the
    // highway's offsetParent-based rAF gate — so without this the underlying
    // renderer (e.g. the 3D Highway WebGL overlay) keeps rendering full-tilt
    // behind the opaque tab view. setVisible(false) trips the gate (pausing
    // the host draw) and fires highway:visibility so overlay renderers hide
    // their sibling DOM; setVisible(null) restores DOM-based detection when
    // we hand the highway back. Guarded for older cores without the API.
    // (slopsmith#654)
    function _tvSetHighwayVisible(v) {
        // Splitscreen: window.highway is the *main-player* highway, not a
        // per-panel instance, and panels expose no per-canvas setVisible
        // (only panelChromeFor). So only *force-hide* (false) in single-
        // player mode — where _tvHighwayCanvas IS window.highway's canvas;
        // forcing it from a panel would pause the wrong renderer and panels
        // would race the shared gate. Clearing the override (null) is always
        // safe and idempotent, and MUST run even if splitscreen became
        // active after a single-player hide, so a prior force-hide can't
        // strand the global highway paused. (slopsmith#654)
        if (v === false && _ssActive()) return;
        try {
            const hw = window.highway;
            if (hw && typeof hw.setVisible === 'function') hw.setVisible(v);
        } catch (_) { /* best-effort: visibility hint only */ }
    }

    // ── Container setup ─────────────────────────────────────────────

    function _tvCreateContainer() {
        if (_tvContainer) return _tvContainer;
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return null;

        // The overlay is positioned with left:0/right:0 to inherit width
        // from the mount; that requires the mount to be a positioned
        // ancestor. Existing splitscreen/main-player mounts are; this
        // is an idempotent guard so a future host with a static mount
        // doesn't silently collapse our overlay to 0 width. The original
        // inline position value is saved to _tvPrevMountPosition so
        // _tvRemoveContainer() can restore it on teardown.
        if (getComputedStyle(mount).position === 'static') {
            _tvPrevMountPosition = mount.style.position; // save inline value (often '')
            mount.style.position = 'relative';
        }

        const c = document.createElement('div');
        c.id = 'tabview-container-' + _instanceId;
        c.className = 'tabview-container';
        c.dataset.tabviewInstance = String(_instanceId);
        // visibility:hidden (not display:none) so alphaTab can measure
        // the container's width during init. With display:none the
        // element is out of layout and clientWidth is 0, which makes
        // alphaTab skip the render entirely (warning: "AlphaTab skipped
        // rendering because of width=0"). renderFinished swaps
        // visibility to '' once the first paint lands, preserving the
        // flash-free handoff this layer was originally designed for.
        c.style.cssText = [
            'visibility:hidden',
            'position:absolute',
            'top:0',
            'left:0',
            'right:0',
            'overflow-y:auto',
            'background:#fff',
            'z-index:5',
        ].join(';');

        const inner = document.createElement('div');
        inner.id = 'tabview-at-' + _instanceId;
        inner.className = 'tabview-at';
        c.appendChild(inner);

        // Playback marker overlay (slopsmith#734). A Songsterr-style
        // vertical band: a translucent fill spanning the current beat's
        // width + staff height, with a bright left border reading as the
        // playhead at the beat's leading edge. Positioned from boundsLookup
        // geometry in _tvUpdateMarker — NOT from alphaTab's internal cursor.
        const hl = document.createElement('div');
        hl.id = 'tabview-marker-' + _instanceId;
        hl.className = 'tabview-marker';
        hl.style.cssText = [
            'position:absolute',
            'left:0',
            'top:0',
            'width:0',
            'height:0',
            'background:rgba(34,211,238,0.16)',
            'border-left:2px solid rgba(34,211,238,0.95)',
            'box-shadow:0 0 8px rgba(34,211,238,0.55)',
            'pointer-events:none',
            'z-index:999',
            'display:none',
        ].join(';');
        c.appendChild(hl);

        mount.appendChild(c);
        _tvContainer = c;
        _tvAtMount = inner;
        _tvHighlight = hl;

        // Re-inset on content reflow of #player-controls (e.g. flex-wrap
        // promotes the controls to a second row at narrow widths).
        if (!_ssActive() && typeof ResizeObserver !== 'undefined') {
            const controls = document.getElementById('player-controls');
            if (controls) {
                _tvControlsObserver = new ResizeObserver(() => _tvSizeContainer());
                _tvControlsObserver.observe(controls);
            }
        }
        return c;
    }

    function _tvSizeContainer() {
        if (!_tvContainer) return;
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return;
        // Splitscreen: fill the panel chrome top-to-bottom (the panel bar
        // layers on top via z-index). Main-player: clear #player-hud at
        // the top and #player-controls at the bottom (slopsmith#336 —
        // the previous code reserved the wrong edge, hiding the last
        // tab row behind the controls bar). Measure dynamically so the
        // controls' flex-wrap to a second row at narrow widths still
        // leaves the last row visible. Fallbacks match the historical
        // 60px top assumption + a single-row controls bar.
        let topInset = 0;
        let bottomInset = 0;
        if (!_ssActive()) {
            const hud = document.getElementById('player-hud');
            const controls = document.getElementById('player-controls');
            topInset = (hud && hud.offsetHeight) || 60;
            bottomInset = (controls && controls.offsetHeight) || 48;
        }
        _tvContainer.style.top = topInset + 'px';
        _tvContainer.style.height = Math.max(0, mount.clientHeight - topInset - bottomInset) + 'px';
        // After a resize alphaTab re-lays-out and rebuilds boundsLookup,
        // so the marker's geometry changes even at the same tick. Re-place
        // it from the last known beat; _tvSyncCursor skips redundant
        // same-tick updates, so resize has to drive this itself.
        _tvUpdateMarker();
    }

    function _tvRemoveContainer() {
        if (_tvControlsObserver) {
            try { _tvControlsObserver.disconnect(); } catch (_) {}
            _tvControlsObserver = null;
        }
        if (_tvContainer) {
            // Restore mount's position style if we changed it in _tvCreateContainer().
            if (_tvPrevMountPosition !== null) {
                const mount = _tvContainer.parentElement;
                if (mount) mount.style.position = _tvPrevMountPosition;
                _tvPrevMountPosition = null;
            }
            _tvContainer.remove();
            _tvContainer = null;
            _tvAtMount = null;
            _tvHighlight = null;
        }
    }

    // ── Error banner ────────────────────────────────────────────────
    //
    // When alphaTab fails to build/render a score, we hide the tabview
    // container so the 2D highway stays visible. That alone leaves the
    // failure silent to anyone who can't open devtools. A small,
    // auto-dismissing banner anchored to this instance's mount surfaces
    // the error without covering the highway — living OUTSIDE the
    // tabview container so it coexists with the fallback renderer
    // instead of occluding it.

    function _tvShowErrorBanner(message) {
        _tvRemoveErrorBanner();
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return;
        const banner = document.createElement('div');
        banner.id = 'tabview-error-banner-' + _instanceId;
        banner.className = 'tabview-error-banner';
        banner.dataset.tabviewInstance = String(_instanceId);
        banner.setAttribute('role', 'alert');
        banner.style.cssText = [
            'position:absolute',
            'top:10px',
            'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(220,80,80,0.94)',
            'color:#fff',
            'padding:8px 16px',
            'border-radius:8px',
            'z-index:30',
            'font-size:12px',
            'font-family:system-ui,sans-serif',
            'max-width:80%',
            'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
            'pointer-events:none',
        ].join(';');
        banner.textContent = 'Tab View: ' + (message || 'failed to load');
        mount.appendChild(banner);
        _tvErrorBanner = banner;
        _tvErrorBannerTimeout = setTimeout(_tvRemoveErrorBanner, 6000);
    }

    function _tvRemoveErrorBanner() {
        if (_tvErrorBanner) {
            _tvErrorBanner.remove();
            _tvErrorBanner = null;
        }
        if (_tvErrorBannerTimeout) {
            clearTimeout(_tvErrorBannerTimeout);
            _tvErrorBannerTimeout = null;
        }
    }

    // ── Failure handling ─────────────────────────────────────────────
    // Shared by a score-build failure (synchronous) and an alphaTab
    // render/parse error (async, via the api's error event): hide any
    // stale tab overlay and fall back to the still-visible 2D highway.
    function _tvShowFailure(message) {
        _tvReady = false;
        if (_tvContainer) _tvContainer.style.visibility = 'hidden';
        if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
        _tvSetHighwayVisible(null);
        console.warn('[TabView] ' + message);
        _tvShowErrorBanner(message);
    }

    // Detaches the current render's scoreLoaded/renderFinished/error
    // listeners from the persistent _tvApi (see _tvInitAlphaTab). Called
    // before registering a new render's listeners, on any render failure,
    // and on teardown — every place a generation of listeners stops being
    // the "current" one, so none are ever left dangling on the live api.
    function _tvUnsubscribeAll() {
        if (!_tvUnsubscribe) return;
        for (const off of _tvUnsubscribe) { try { off(); } catch (_) {} }
        _tvUnsubscribe = null;
    }

    // ── alphaTab init / render ───────────────────────────────────────

    // Caller must have already confirmed a container exists (_tvContainer).
    //
    // The AlphaTabApi instance persists across chart rebuilds (song switch,
    // mastery move, a chart-transform provider rerunning) — only destroyed
    // in _teardown() — instead of being torn down and recreated on every
    // one, since renderScore() on a live instance is the API's own
    // documented way to switch what it's showing. Each render still needs
    // its own scoreLoaded/renderFinished/error closures (they capture this
    // call's notesRef/myToken), so the previous render's listeners are
    // unregistered first via the unregister functions .on() returns.
    //
    // We deliberately do NOT clear _tvAtMount's DOM ourselves before
    // re-rendering (unlike the old destroy/recreate design, which cleared
    // it because it also destroyed and rebuilt the api). Verified against
    // the pinned alphaTab source (BrowserUiFacade.beginAppendRenderResults,
    // dist/alphaTab.js): the api creates its own canvas element ONCE at
    // construction and holds a direct reference to it, and each render
    // pass's preRender handler resets its own result counter, then removes
    // any leftover child elements past that count ("remove elements that
    // might be from a previous render session," verbatim from that
    // function). Clearing the mount out from under it here would desync
    // that bookkeeping and break the *next* render instead of the current
    // one, for no benefit — the api already replaces its own prior output.
    function _tvInitAlphaTab(score, notesRef, myToken) {
        if (!_tvApi) {
            _tvApi = new alphaTab.AlphaTabApi(_tvAtMount, {
                core: {
                    fontDirectory: ALPHATAB_CDN_BASE + '/font/',
                    // Build the bounds lookup during layout so we can map a
                    // beat → rendered pixel geometry for our own marker
                    // (slopsmith#734). Without this api.boundsLookup is null.
                    includeNoteBounds: true,
                },
                display: {
                    layoutMode: alphaTab.LayoutMode.Page,
                    scale: 0.9,
                },
                player: {
                    // No alphaTab synth: slopsmith owns audio. Disabling the
                    // player drops the soundfont CDN download entirely and,
                    // crucially, removes the player-ready dependency that the
                    // old .at-cursor-bar marker relied on (slopsmith#734).
                    enablePlayer: false,
                },
            });
        }

        _tvUnsubscribeAll();
        _tvReady = false;
        _tvAtBeats = [];
        _tvLastBeat = null;
        // Set once renderFinished fires for the first time under this
        // generation — distinguishes "this chart just replaced the
        // previous one" (reset scroll, see below) from a later
        // resize-driven re-layout of the SAME chart (must NOT reset it).
        let isFirstRenderForThisGeneration = true;

        // On load, flatten the score into a tick-sorted beat timeline so
        // _tvSyncCursor can resolve the current playback tick → Beat →
        // boundsLookup geometry. Single track (score-builder emits one).
        const offScoreLoaded = _tvApi.scoreLoaded.on(function (loadedScore) {
            if (_tvInitToken !== myToken) return;
            _tvAtBeats = _tvBuildBeatTimeline(loadedScore);
            _tvLastBeat = null;
        });

        const offRenderFinished = _tvApi.renderFinished.on(function () {
            if (_tvInitToken !== myToken) return;
            _tvReady = true;
            // Start the self-driven cursor loop here (not in init()): _tvReady
            // is only true once the score has rendered, so starting earlier
            // just idle-spins for the whole async render.
            _tvStartCursorLoop();
            // Swap visibility only once alphaTab has actually produced
            // output — the first frame lands several rAFs after
            // renderScore() returns, or never if rendering fails.
            if (_tvContainer) _tvContainer.style.visibility = '';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = 'hidden';
            _tvSetHighwayVisible(false);
            if (isFirstRenderForThisGeneration) {
                isFirstRenderForThisGeneration = false;
                // The container/scroll position persists across rebuilds
                // along with _tvApi — reset it here, now that the new
                // chart's content has actually replaced the old (doing
                // this any earlier would visibly snap the STILL-DISPLAYED
                // previous chart to the top-left before the swap happens),
                // so switching to a shorter arrangement doesn't leave the
                // view scrolled past the new content until playback
                // catches up.
                if (_tvContainer) { _tvContainer.scrollTop = 0; _tvContainer.scrollLeft = 0; }
            }
            _tvCurrentNotesRef = notesRef;
            _tvPendingNotesRef = null;
            _tvFailedNotesRef = null;
            // A successful render supersedes any prior error banner.
            _tvRemoveErrorBanner();
            // renderFinished fires after EVERY (re)layout, including a
            // resize-driven re-render. boundsLookup is freshly valid at
            // this point, so re-place the marker from the last known beat:
            // a width-change resize transiently nulls boundsLookup, and
            // _tvSizeContainer's _tvUpdateMarker() call mid-relayout hides
            // the marker — without this it would stay hidden while paused
            // (or until _tvSyncCursor's tick advances >30) (slopsmith#734).
            // No-op on the first render (_tvLastBeat is null → marker hidden).
            _tvUpdateMarker();
        });

        const offError = _tvApi.error.on(function (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView] alphaTab error:', e);
            // This generation has definitively failed — detach its own
            // listeners now instead of leaving them attached to the live
            // _tvApi until some later render attempt happens to clean up.
            _tvUnsubscribeAll();
            _tvPendingNotesRef = null;
            _tvFailedNotesRef = notesRef;
            const msg = (e && e.message) ? e.message : (typeof e === 'string' ? e : 'render failed');
            _tvShowFailure(msg);
        });

        _tvUnsubscribe = [offScoreLoaded, offRenderFinished, offError];

        try {
            score.finish(_tvApi.settings);
            _tvApi.renderScore(score, [0]);
        } catch (e) {
            // _tvUnsubscribe unambiguously refers to the 3 listeners just
            // registered above (nothing else could have reassigned it in
            // between) — safe to detach immediately here, unlike in the
            // caller's catch, which can also be reached without this
            // function ever having run (see _tvRenderFromBundle). Re-throw
            // so that shared failure bookkeeping (_tvFailedNotesRef, the
            // banner) still happens in the one place that owns it.
            _tvUnsubscribeAll();
            throw e;
        }
    }

    // Builds the score from `bundle` and renders it. Awaits the one-time
    // alphaTab CDN script load FIRST — buildScoreFromBundle and
    // _tvInitAlphaTab both need window.alphaTab, and _tvLoadScript is the
    // only place that ever requests the CDN script, so building the score
    // before awaiting it would permanently fail (and never even fetch the
    // script) on every cold activation.
    async function _tvRenderFromBundle(bundle, myToken) {
        if (!bundle) return;
        if (!_resolveMount(_tvHighwayCanvas)) return;

        // One snapshot for this whole render attempt — draw()'s dirty-check
        // and every ref written below must agree on the same normalized
        // value (bundle.notes is read exactly once here, not re-read at
        // each step), so a falsy-but-not-null bundle.notes can't desync
        // the buildInFlight/previouslyFailed guards from draw()'s check.
        const notesRef = bundle.notes || null;

        // Mark this ref "in flight" for the WHOLE attempt, starting before
        // the CDN-load await — not just from the point buildScoreFromBundle
        // succeeds. Otherwise, on a cold activation (script not yet
        // fetched), every draw() frame during that network wait sees
        // buildInFlight===false and re-invokes this function, stacking up
        // redundant attempts against the one shared load promise.
        _tvPendingNotesRef = notesRef;

        try {
            await _tvLoadScript();
            if (_tvInitToken !== myToken) return;

            const score = buildScoreFromBundle(window.alphaTab && window.alphaTab.model, bundle);
            if (!score) {
                _tvPendingNotesRef = null;
                _tvFailedNotesRef = notesRef;
                return;
            }

            // _tvCreateContainer returns null when the mount target isn't in
            // the DOM (player screen closed, unusual timing during screen
            // transitions). Clear the pending marker so the next draw()
            // retries cleanly instead of treating this ref as permanently
            // in flight.
            const container = _tvCreateContainer();
            if (!container) {
                _tvPendingNotesRef = null;
                console.warn('[TabView] mount container missing; leaving highway visible');
                if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
                _tvSetHighwayVisible(null);
                return;
            }
            _tvSizeContainer();

            // _tvPendingNotesRef stays set (guarding against a re-trigger)
            // until renderFinished/error resolves it — alphaTab's render
            // pipeline is async from here (renderFinished fires several rAFs
            // later, or never on failure). DO NOT show the container or hide
            // the highway here; that visibility swap happens in
            // renderFinished/error so the player isn't stranded blank
            // mid-render.
            _tvInitAlphaTab(score, notesRef, myToken);
        } catch (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView] render failed:', e);
            // Do NOT _tvUnsubscribeAll() here: if this throw happened before
            // _tvInitAlphaTab ever ran for this attempt (CDN load or score
            // build failed), _tvUnsubscribe still correctly belongs to a
            // DIFFERENT, still-live prior generation — detaching it here
            // would silently drop that generation's still-valid listeners.
            // _tvInitAlphaTab owns cleanup of its OWN listeners on a
            // finish()/renderScore() failure (see its own try/catch).
            _tvPendingNotesRef = null;
            _tvFailedNotesRef = notesRef;
            _tvShowFailure((e && e.message) ? e.message : String(e));
        }
    }

    // ── Beat timeline (tick → Beat) ─────────────────────────────────

    // Flatten the loaded score into a tick-sorted [{ beat, start }] list.
    // `start` is absoluteDisplayStart in 960-ppq MIDI ticks (bar 0 beat 0
    // == tick 0). One track only (score-builder emits a single guitar/bass
    // track); voice 0 carries the notes. Returns [] on any unexpected shape
    // so the marker simply stays hidden rather than throwing on the rAF path.
    function _tvBuildBeatTimeline(score) {
        const out = [];
        try {
            const track = score && score.tracks && score.tracks[0];
            const staff = track && track.staves && track.staves[0];
            const bars = staff && staff.bars;
            if (!bars) return out;
            for (let i = 0; i < bars.length; i++) {
                const voices = bars[i].voices || [];
                const voice = voices[0];
                const beats = voice && voice.beats;
                if (!beats) continue;
                for (let j = 0; j < beats.length; j++) {
                    const b = beats[j];
                    const start = (typeof b.absoluteDisplayStart === 'number')
                        ? b.absoluteDisplayStart
                        : b.absolutePlaybackStart;
                    if (typeof start === 'number') out.push({ beat: b, start: start });
                }
            }
        } catch (_) { /* malformed score → empty timeline → marker hidden */ }
        out.sort(function (a, b) { return a.start - b.start; });
        return out;
    }

    // Greatest beat whose start <= tick (the beat currently sounding).
    // Binary search — runs once per advanced tick, per instance.
    function _tvFindBeatAtTick(tick) {
        const arr = _tvAtBeats;
        if (!arr || arr.length === 0) return null;
        if (tick < arr[0].start) return arr[0].beat;
        const ans = _countLE(arr, tick, b => b.start) - 1;
        return arr[ans].beat;
    }

    // ── Cursor sync ─────────────────────────────────────────────────

    function _tvSyncCursor(currentTime) {
        if (!_tvApi || !_tvReady) return;

        const tick = _tvTimeToTick(currentTime, _tvLatestBeats);
        // Skip the (relatively expensive) beat lookup + marker reposition
        // when the tick hasn't advanced — at 60fps × N splitscreen
        // instances that's meaningful cost for state that doesn't change
        // between frames. Resize-driven movement still re-places the
        // marker via _onWinResize → _tvSizeContainer → _tvUpdateMarker.
        if (Math.abs(tick - _tvLastTick) <= 30) return;
        _tvLastTick = tick;
        _tvLastBeat = _tvFindBeatAtTick(tick);
        _tvUpdateMarker();
    }

    // ── Self-driven cursor loop (slopsmith#734 follow-up) ────────────
    //
    // Single-player Tab View hides the highway via setVisible(false) so the
    // occluded underlying renderer stops burning GPU behind the opaque tab
    // (slopsmith#654). But that same flag gates the host's per-frame draw
    // pump (`highway.js`: `if (!_lastVisible) return` *before* it calls the
    // active renderer's draw(bundle)) — and we ARE the active renderer. So
    // our draw(bundle) stopped being called the instant the first render
    // finished, and the boundsLookup marker silently froze / never appeared.
    //
    // Fix: advance the marker from our own requestAnimationFrame loop,
    // reading the clock + beats straight off window.highway, so the cursor
    // no longer depends on whether the host pumps draw().
    //
    // Time source is getTime() (chartTime — the AUDIO-aligned clock), NOT
    // bundle.currentTime. bundle.currentTime is the *render* clock
    // (chartTime + avOffset); on stem songs avOffset is non-zero (e.g.
    // −215 ms), which dragged the marker onto the previous note. getTime()
    // is exactly the audio position, so the marker sits on the note you hear.
    //
    // Splitscreen still rides the per-panel draw(bundle) path: setVisible
    // (false) is skipped there (so draw() keeps flowing), and window.highway
    // is the *main* player's instance — wrong clock/beats for a panel — so
    // the loop bows out when _ssActive().
    function _tvCursorLoop() {
        _tvCursorRAF = window.requestAnimationFrame(_tvCursorLoop);
        if (!_isReady || !_tvReady) return;
        if (_ssActive()) return;
        const hw = window.highway;
        if (!hw || typeof hw.getTime !== 'function') return;
        if (typeof hw.getBeats === 'function') {
            const b = hw.getBeats();
            if (b) _tvLatestBeats = b;
        }
        // getTime() can return NaN in transient states (pre-anchor boot,
        // mid-seek flush — see highway.js). Feeding NaN to _tvSyncCursor
        // resolves to lookupTick 0 and snaps the marker back to beat 0, so
        // skip the frame instead.
        const t = hw.getTime();
        if (t == null || !isFinite(t)) return;
        _tvSyncCursor(t);
    }

    function _tvStartCursorLoop() {
        if (_tvCursorRAF != null) return;
        _tvCursorRAF = window.requestAnimationFrame(_tvCursorLoop);
    }

    function _tvStopCursorLoop() {
        if (_tvCursorRAF != null) {
            window.cancelAnimationFrame(_tvCursorRAF);
            _tvCursorRAF = null;
        }
    }

    // ── Playback marker (boundsLookup-driven, slopsmith#734) ─────────

    function _tvUpdateMarker() {
        if (!_tvHighlight || !_tvContainer || !_tvAtMount) return;
        if (!_tvLastBeat) { _tvHighlight.style.display = 'none'; return; }

        // boundsLookup is rebuilt on every (re)layout; it can be briefly
        // null between a resize and the next renderFinished. Bail quietly.
        const bl = _tvApi && _tvApi.boundsLookup;
        const bb = bl ? bl.findBeat(_tvLastBeat) : null;
        const vb = bb && bb.visualBounds;
        if (!vb) { _tvHighlight.style.display = 'none'; return; }

        // visualBounds are in the rendered surface's coordinate space,
        // whose origin is _tvAtMount's content box. Both the marker and
        // _tvAtMount are absolutely positioned children of the scrolling
        // _tvContainer, so they share its scrolled space — add _tvAtMount's
        // offset, no scroll math needed. The translucent band spans the
        // beat's width; the bright left border (static CSS) reads as the
        // playhead at the beat's leading edge.
        const baseX = _tvAtMount.offsetLeft;
        const baseY = _tvAtMount.offsetTop;

        const left = Math.round(baseX + vb.x);
        const top = Math.round(baseY + vb.y);
        const width = Math.max(2, Math.round(vb.w));
        const height = Math.max(8, Math.round(vb.h));

        _tvHighlight.style.left = left + 'px';
        _tvHighlight.style.top = top + 'px';
        _tvHighlight.style.width = width + 'px';
        _tvHighlight.style.height = height + 'px';
        _tvHighlight.style.display = '';

        // Auto-advance: scroll to keep the marker comfortably in view.
        const viewW = _tvContainer.clientWidth;
        const viewH = _tvContainer.clientHeight;
        const paddingX = Math.min(180, viewW * 0.3);
        const paddingY = Math.min(100, viewH * 0.25);

        const relX = left - _tvContainer.scrollLeft;
        const relY = top - _tvContainer.scrollTop;

        let needScroll = false;
        let targetX = _tvContainer.scrollLeft;
        let targetY = _tvContainer.scrollTop;

        if (relX < paddingX || relX > viewW - paddingX) {
            targetX = left - viewW / 2;
            needScroll = true;
        }
        if (relY < paddingY || relY > viewH - paddingY) {
            targetY = top - viewH / 2;
            needScroll = true;
        }

        if (needScroll) {
            _tvContainer.scrollTo({
                left: Math.max(0, targetX),
                top: Math.max(0, targetY),
                behavior: 'auto',
            });
        }
    }

    // ── Teardown ────────────────────────────────────────────────────

    function _teardown(restoreCanvas) {
        _tvStopCursorLoop();
        _tvReady = false;
        _tvLastTick = -9999;
        _tvCurrentNotesRef = null;
        _tvPendingNotesRef = null;
        _tvFailedNotesRef = null;
        _tvLatestBeats = null;
        _tvAtBeats = [];
        _tvLastBeat = null;
        // Detach this generation's listeners before destroying the api —
        // don't rely on AlphaTabApi.destroy() to also clear its own event
        // emitters' subscriber lists.
        _tvUnsubscribeAll();
        if (_tvApi) {
            try { _tvApi.destroy(); } catch (_) {}
            _tvApi = null;
        }
        _tvRemoveContainer();
        _tvRemoveErrorBanner();
        if (restoreCanvas && _tvHighwayCanvas) {
            _tvHighwayCanvas.style.visibility = _tvPrevVisibility;
            _tvSetHighwayVisible(null);
            _tvHighwayCanvas = null;
            _tvPrevVisibility = '';
        }
    }

    // ── Factory return: setRenderer contract ────────────────────────

    return {
        init(canvas, bundle) {
            // Bump the token BEFORE tearing down (matching destroy()'s
            // order below), not after: _teardown() destroys _tvApi, and if
            // that synchronously re-fires a still-attached listener (e.g.
            // AlphaTabApi.destroy() emitting its own error/renderFinished),
            // that listener's staleness guard must already see a mismatched
            // token, or it would run its full body against state this very
            // call is mid-resetting.
            const myToken = ++_tvInitToken;

            // Always run teardown at init start, even when there's
            // no visible container/API to tear down. A previous
            // activation that failed BEFORE alphaTab initialised
            // (e.g. CDN load error, build error pre-container) would
            // otherwise leak _tvFailedNotesRef into this lifetime —
            // the new build would hit the previouslyFailed guard in
            // draw() and silently skip, so re-picking Tab View would
            // appear to do nothing.
            //
            // restoreCanvas=true (not false) is critical here: a
            // prior successful render hid the highway canvas via
            // renderFinished, and skipping the restore would leave
            // the canvas at visibility:hidden when the new init
            // captures _tvPrevVisibility below — so a subsequent
            // failed build/render would "restore" the canvas to
            // hidden and strand the player blank. The
            // _tvHighwayCanvas reference is also nulled by the
            // restore branch, freeing the new init() to install
            // the freshly-passed canvas without aliasing.
            _teardown(/* restoreCanvas */ true);
            window.removeEventListener('resize', _onWinResize);

            _tvHighwayCanvas = canvas;
            _tvPrevVisibility = canvas ? canvas.style.visibility : '';

            // DON'T hide the 2D highway yet — if the CDN load or the
            // score build/render fails, we want the default visible as
            // a fallback so the player isn't stranded blank. The hide
            // happens inside renderFinished on success, and a failure
            // restores _tvPrevVisibility explicitly.

            window.addEventListener('resize', _onWinResize);

            _tvRenderFromBundle(bundle, myToken);

            _isReady = true;
            // The self-driven cursor loop (the marker can't rely on the host
            // draw() pump once the highway is hidden — slopsmith#654 gate) is
            // started from renderFinished, once _tvReady is true, so it
            // doesn't idle-spin through the async render.
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Cache beats per frame so cursor sync uses the
            // filter-aware beats from THIS instance's bundle, not
            // the main-player's `highway` global (which under
            // splitscreen belongs to the hidden default highway and
            // wouldn't reflect this panel's arrangement).
            _tvLatestBeats = bundle.beats || null;

            // Rebuild whenever bundle.notes' identity differs from what the
            // currently-rendered score reflects — covers song/arrangement
            // changes AND a chart-transform provider rerunning (retune
            // toggle, capo/octave tweak, mastery move), since highway.js
            // restages a fresh notes array on every one of those. Guarded
            // against per-frame retry storms the same way the old fetch
            // path was: skip while a build is already in flight for this
            // exact ref, and skip a ref that just failed.
            const notesRef = bundle.notes || null;
            const chartChanged = notesRef !== _tvCurrentNotesRef;
            const buildInFlight = _tvPendingNotesRef !== null && _tvPendingNotesRef === notesRef;
            const previouslyFailed = _tvFailedNotesRef !== null && _tvFailedNotesRef === notesRef;
            if (chartChanged && !buildInFlight && !previouslyFailed) {
                // Defense-in-depth mount check. _tvRenderFromBundle also
                // guards (and is the single source of truth), but doing
                // the check here too saves a per-frame _tvInitToken bump
                // while the panel chrome is transient-null; tokens are
                // cheap but the bump+bail pattern is dead work.
                if (_resolveMount(_tvHighwayCanvas)) {
                    const myToken = ++_tvInitToken;
                    _tvLastTick = -9999;
                    _tvRenderFromBundle(bundle, myToken);
                    // fall through — cursor sync below will be a no-op
                    // until _tvReady flips true again after the re-render.
                }
            }

            // Splitscreen only. In single-player the rAF loop
            // (_tvCursorLoop) owns the marker, driven from the
            // audio-aligned highway.getTime(). Letting draw() ALSO drive
            // it would double-sync from a second clock: bundle.currentTime
            // is the render clock (chartTime + avOffset), so on a core
            // where the host pump isn't gated off (no highway.setVisible,
            // or the one transition frame before the highway hides) the
            // marker would flip a beat back and forth every frame between
            // audio time and render time. The loop bows out under
            // _ssActive(), so the two paths stay mutually exclusive.
            if (_ssActive()) {
                // Same NaN/finite guard as the single-player _tvCursorLoop:
                // bundle.currentTime can be NaN in transient states, and
                // feeding NaN into _tvSyncCursor would set _tvLastTick to
                // NaN permanently — Math.abs(NaN - anything) is never <= 30,
                // so the "skip redundant frame" check could never trip
                // again for this instance's lifetime.
                const t = bundle.currentTime;
                if (t != null && isFinite(t)) _tvSyncCursor(t);
            }
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _tvSizeContainer();
        },
        destroy() {
            _isReady = false;
            _tvInitToken++;  // invalidate in-flight builds/renders
            window.removeEventListener('resize', _onWinResize);
            _teardown(/* restoreCanvas */ true);
        },
    };
}

// Arrangement-agnostic — Auto mode should not auto-select tabview.
// (The static matchesArrangement is intentionally absent.)

window.slopsmithViz_tabview = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_tabview = window.slopsmithViz_tabview;

})();
