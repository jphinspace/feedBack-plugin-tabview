# Tab View — Constitution

## Inheritance

feedBack's core plugin contract governs everything in this repo (manifest,
plugin context: `get_dlc_dir`, `get_sloppak_cache_dir`, asset serving, the
`slopsmithViz_*` visualization factory contract, splitscreen mounting). This
constitution lists Tab View's own non-negotiables.

## Core Principles

### I. alphaTab is the renderer; we're the bridge
Tab View MUST NOT render notation glyphs itself. alphaTab is the source of
truth for all musical glyphs, beam grouping, stems, and bar layout. Our job
is to translate arrangement XML → Guitar Pro 5 (`rs2gp.py`) and to drive
alphaTab's cursor (`tickPosition`) from `audio.currentTime` using beat
timing data the highway already exposes.

### II. Multi-instance by construction (slopsmith#36)
Per-instance state lives in factory closures returned from `createFactory()`.
Module-level scope is reserved for genuine singletons:
- The CDN script load promise (one `<script>` per page).
- `_tvFilename` captured from `window.playSong` and `arrangement:changed`
  (one global player → one filename, even when multiple panels render
  different arrangements of the same song).
- `_nextInstanceId` for unique DOM ids.

### III. Pin the alphaTab CDN version
`ALPHATAB_VERSION = '1.8.2'` MUST be an explicit constant. New jsDelivr
cache invalidations or upstream breaking changes cannot land silently in
production. Bumps require local QA against cursor-sync and tab-highlight
behaviour.

### IV. Path-traversal guard on the GP5 endpoint
`GET|POST /api/plugins/tabview/gp5/{filename:path}` MUST resolve `filename`
under the configured DLC dir and reject anything that escapes (`..`, absolute
paths). Both verbs share one guard (`_resolve_song_path` in routes.py); the
endpoint is publicly mounted, and the guard is the single defence. The POST
variant additionally carries a chart-transform override payload (notes/
chords/tuning/stringCount) in the JSON body — see Principle VII.

### V. Sloppak path is loaded lazily
Older feedBack cores ship without `lib/sloppak.py`. A top-level
`import sloppak` here would disable Tab View entirely on those installs
(including for archive songs). The sloppak branch MUST `import sloppak`
inside the function and surface a `501 Not Implemented` when missing.

### VI. Visualization is opt-in (`matchesArrangement` deliberately absent)
Tab View does not advertise itself as the auto-select renderer for any
arrangement type. Users explicitly switch to it via the Tab View button in
the player controls. Adding `matchesArrangement` would require careful UX
review.

### VII. The tab reflects the chart-transform-effective chart, not the disk file
Tab View MUST NOT convert the raw on-disk arrangement when an effective
chart is available. screen.js gathers notes/chords/tuning/stringCount from
`window.highway`'s getters (main player) or the per-instance `bundle`
(splitscreen) and POSTs them as the override body; `rs2gp.arrangement_to_gp5`'s
`overrides` param decodes that wire-format payload in place of
`arr.notes`/`arr.chords`/`arr.tuning`, since chart-transform is a
browser-only hook the backend can't otherwise observe. Measures/tempo/
metadata always come from `song`/`arr` regardless. The plain GET MUST keep
converting straight from `arr`/`song` unchanged, as the back-compat path.

## Governance

Amendments touching the GP5 conversion (`rs2gp.py`) must keep a back-compat
fall-through for older arrangement XML formats. Amendments touching the
factory contract must align with whatever the latest core
`slopsmithViz_*` interface requires.

**Version**: 3.1.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-07-22
