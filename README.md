# slopsmith-plugin-tabview

A [feedBack](https://github.com/got-feedback/feedback) plugin that renders custom-song arrangements as traditional guitar tablature using [alphaTab](https://www.alphatab.net/).

## Features

- Converts arrangement XML to Guitar Pro 5 format on the fly
- Renders scrolling tablature notation via alphaTab in the browser
- Cursor syncs to the existing audio playback
- Supports guitar and bass arrangements
- Preserves techniques: bends, slides, hammer-ons, pull-offs, harmonics, palm mutes, tremolo picking
- Handles custom tunings and capo
- Per-measure tempo changes
- Reflects any active chart-transform provider — the tab shows the effective notes/strings/tuning, not just the original chart

## Installation

Copy (or symlink) this directory into your feedBack `plugins/` folder:

```bash
cd /path/to/feedBack/plugins
git clone https://github.com/got-feedback/feedback-plugin-tabview.git tabview
```

Restart feedBack. The plugin loads automatically.

## Usage

1. Open any song in the player
2. Click the **Tab View** button in the player controls bar
3. The highway canvas is replaced with scrolling tablature notation
4. The cursor follows the audio playback
5. Click **Highway** to switch back to the note highway

## Dependencies

- **Server**: `pyguitarpro` (already included in feedBack's requirements)
- **Client**: alphaTab is loaded from CDN on first use

## How it works

1. **routes.py** exposes `GET|POST /api/plugins/tabview/gp5/{filename}?arrangement=N`. `POST`'s body carries the effective `{notes, chords, tuning, stringCount}`; `GET` converts the raw arrangement unchanged and is the fallback for older cores.
2. **rs2gp.py** converts the arrangement into a Guitar Pro 5 file via `pyguitarpro`. Given a POST `overrides` payload, notes/chords/tuning/string count come from it instead of the arrangement; measures/tempo/metadata always come from the arrangement.
3. **screen.js** loads alphaTab from CDN, gathers the current chart (`window.highway`'s getters, or the per-instance `bundle` under splitscreen), POSTs it alongside the fetch, renders the returned GP5, and syncs the cursor to `audio.currentTime`

A chart-transform provider can register a browser-only hook that remaps notes/chords/tuning after difficulty filtering; Tab View reads that effective chart via `window.highway`'s getters and forwards it to the server instead of re-deriving from the original song file.

## Files

| File | Purpose |
|------|---------|
| `plugin.json` | Plugin manifest |
| `routes.py` | FastAPI endpoint serving GP5 files |
| `rs2gp.py` | arrangement → Guitar Pro 5 converter |
| `screen.js` | Frontend: alphaTab integration, cursor sync, UI |
