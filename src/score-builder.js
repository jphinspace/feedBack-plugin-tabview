// Builds an alphaTab Score directly from the highway's chart bundle
// (notes/chords/tuning/stringCount/beats), in place of the old GP5-via-
// pyguitarpro round trip. bundle.notes/.chords/.tuning/.stringCount are
// already the EFFECTIVE, chart-transform-applied chart (highway.js applies
// any registered transform before building the bundle), so building
// straight from bundle means any prior plugin's remap reaches the tab.
//
// alphaTab has no string-count ceiling (unlike GP5's hard 7-string cap),
// so extended-range instruments need no remap workaround here.
//
// Rhythm/tuning math lives in chart-quantize.js (no alphaTab dependency,
// see test/chart-quantize.test.mjs); this file is the alphaTab-
// object-construction half (see test/score-builder.test.mjs).

import {
    SUBDIV, parseMeasures, fallbackMeasure, mergeEvents,
    decomposeThirtySeconds, thirtySecondsForDuration, quantizeThirtySecond,
    buildTuning,
} from './chart-quantize.js';

// RS bend is semitones; alphaTab BendPoint.value is quarter-tones (same
// *2 scale GP5 used). A 3-point curve (flat -> full bend held) mirrors the
// old GP5 output's shape.
function applyNoteEffects(note, wire, atModel) {
    if (wire.ho || wire.po) note.isHammerPullOrigin = true;
    if (Number.isInteger(wire.sl) && wire.sl >= 0) note.slideOutType = atModel.SlideOutType.Shift;
    const bendVal = wire.bn;
    if (bendVal && bendVal > 0) {
        const quarterTones = bendVal * 2;
        note.bendType = atModel.BendType.Bend;
        note.bendPoints = [
            new atModel.BendPoint(0, 0),
            new atModel.BendPoint(30, quarterTones),
            new atModel.BendPoint(60, quarterTones),
        ];
    }
    if (wire.hm) note.harmonicType = atModel.HarmonicType.Natural;
    else if (wire.hp) note.harmonicType = atModel.HarmonicType.Pinch;
    if (wire.pm) note.isPalmMute = true;
    if (wire.mt) note.isDead = true;
    if (wire.ac) note.accentuated = atModel.AccentuationType.Normal;
    if (wire.tp) note.isLeftHandTapped = true;
}

function restBeat(atModel, part) {
    const b = new atModel.Beat();
    b.duration = part.duration;
    b.dots = part.dots;
    return b;
}

function restBeats(atModel, thirtySeconds) {
    return decomposeThirtySeconds(thirtySeconds).map(part => restBeat(atModel, part));
}

// One measure's events -> alphaTab Beat[] (rests filling gaps, one Note
// per sounded string per slot — the RS "same string re-struck" collision
// guard mirrors the old GP5 path's one-note-per-string-per-beat limit).
// stringCount bounds-checks wire.s: a chart-transform provider is a less
// trusted data source than the original chart file, and an out-of-range
// string index would otherwise index past staff.tuning and land on NaN
// pitch instead of being safely dropped (the old GP5 path also dropped
// any note whose mapped string fell outside the representable range).
function createBeats(atModel, events, measureInfo, stringCount) {
    const total = measureInfo.numBeats * SUBDIV;
    if (!events.length) return restBeats(atModel, total);

    const slots = new Map();
    for (const ev of events) {
        let pos = quantizeThirtySecond(ev.time, measureInfo.beatTimes, measureInfo.endTime);
        pos = Math.max(0, Math.min(pos, total - 1));
        if (!slots.has(pos)) slots.set(pos, []);
        slots.get(pos).push(ev);
    }
    const positions = [...slots.keys()].sort((a, b) => a - b);

    const beats = [];
    let cursor = 0;
    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (pos > cursor) {
            beats.push(...restBeats(atModel, pos - cursor));
            cursor = pos;
        }
        const next = i + 1 < positions.length ? positions[i + 1] : total;
        const gap = Math.max(1, next - pos);
        const decomposed = decomposeThirtySeconds(gap);

        const beat = new atModel.Beat();
        beat.duration = decomposed[0].duration;
        beat.dots = decomposed[0].dots;

        // alphaTab's Beat model has no per-note tremolo field (only
        // Beat.tremoloPicking), unlike GP5's per-note NoteEffect — so a
        // mixed chord (one tremolo string among plain ones) can't be
        // represented exactly either way. Require EVERY sounded note in
        // the slot to request it before marking the whole beat: silently
        // dropping tremolo on a lone flagged string in a mixed chord is a
        // smaller error than incorrectly tremolo-marking strings that
        // never asked for it.
        let soundedCount = 0;
        let tremoloCount = 0;
        const seen = new Set();
        for (const ev of slots.get(pos)) {
            const wireNotes = ev.type === 'chord' ? ev.chordNotes : [ev.note];
            for (const wire of wireNotes) {
                if (wire.s < 0 || wire.s >= stringCount) continue;
                if (seen.has(wire.s)) continue;
                seen.add(wire.s);
                const note = new atModel.Note();
                // RS string index 0 = lowest; alphaTab Note.string 1 = lowest.
                note.string = wire.s + 1;
                note.fret = wire.f;
                applyNoteEffects(note, wire, atModel);
                soundedCount++;
                if (wire.tr) tremoloCount++;
                beat.addNote(note);
            }
        }
        if (soundedCount > 0 && tremoloCount === soundedCount) {
            const t = new atModel.TremoloPickingEffect();
            t.marks = 1;
            t.style = atModel.TremoloPickingStyle.Default;
            beat.tremoloPicking = t;
        }

        beats.push(beat);
        cursor += thirtySecondsForDuration(decomposed[0]);
        for (let j = 1; j < decomposed.length; j++) {
            beats.push(restBeat(atModel, decomposed[j]));
            cursor += thirtySecondsForDuration(decomposed[j]);
        }
    }
    if (cursor < total) beats.push(...restBeats(atModel, total - cursor));
    return beats;
}

// ── Main entry point ─────────────────────────────────────────────────────

// atModel: the `alphaTab.model` namespace (from the loaded alphaTab CDN
// bundle). bundle: a highway/renderer bundle (notes/chords/tuning/
// stringCount/beats/songInfo) — the same one passed to a custom
// renderer's init(canvas, bundle)/draw(bundle).
export function buildScoreFromBundle(atModel, bundle) {
    if (!bundle) return null;
    const { Score, Track, Staff, Bar, Voice, MasterBar, Tuning, Automation } = atModel;

    const songInfo = bundle.songInfo || {};
    const stringCount = Number.isFinite(bundle.stringCount) && bundle.stringCount >= 1
        ? Math.trunc(bundle.stringCount) : 6;
    const tuningOffsets = Array.isArray(bundle.tuning) && bundle.tuning.length
        ? bundle.tuning : new Array(stringCount).fill(0);
    // Word-boundary match (not a bare substring) so e.g. "BasslineKeys"
    // doesn't misclassify as bass — matches the same convention already
    // established elsewhere in the ecosystem (feedBack-plugin-chart-
    // retuner's arrangementClassFor). There's no more-authoritative signal
    // available here: bundle.songInfo carries only the arrangement's
    // display name, not an instrument-type flag (that only ever existed
    // server-side, in the arrangement file itself).
    const isBass = /\bbass\b/i.test(songInfo.arrangement || '');

    let measures = parseMeasures(bundle.beats);
    if (!measures.length) measures = [fallbackMeasure(songInfo.duration)];
    const events = mergeEvents(bundle.notes, bundle.chords);

    const score = new Score();
    score.title = songInfo.title || '';
    score.artist = songInfo.artist || '';

    const track = new Track();
    track.name = songInfo.arrangement || (isBass ? 'Bass' : 'Guitar');
    score.addTrack(track);
    track.playbackInfo.primaryChannel = isBass ? 1 : 0;
    track.playbackInfo.secondaryChannel = isBass ? 3 : 2;
    track.playbackInfo.program = isBass ? 33 : 30;

    const staff = new Staff();
    staff.stringTuning = new Tuning('', buildTuning(tuningOffsets, isBass, stringCount));
    track.addStaff(staff);

    // events and measures are both time-sorted and contiguous (each
    // measure's endTime is the next one's startTime), so a single forward
    // pointer partitions events measure-by-measure in O(n+m) instead of
    // re-scanning the whole event list per measure.
    let eventIdx = 0;
    while (eventIdx < events.length && measures.length && events[eventIdx].time < measures[0].startTime) eventIdx++;

    let prevBpm = null;
    for (const info of measures) {
        const masterBar = new MasterBar();
        masterBar.timeSignatureNumerator = info.numBeats;
        masterBar.timeSignatureDenominator = 4;
        const bpm = Math.max(30, Math.min(300, Math.round(info.bpm)));
        if (prevBpm === null || bpm !== prevBpm) {
            masterBar.tempoAutomations = [Automation.buildTempoAutomation(false, 0, bpm, bpm)];
        }
        prevBpm = bpm;
        score.addMasterBar(masterBar);

        const bar = new Bar();
        staff.addBar(bar);
        const voice = new Voice();
        bar.addVoice(voice);

        const measureEvents = [];
        while (eventIdx < events.length && events[eventIdx].time < info.endTime) {
            measureEvents.push(events[eventIdx]);
            eventIdx++;
        }
        for (const beat of createBeats(atModel, measureEvents, info, stringCount)) voice.addBeat(beat);
    }

    return score;
}
