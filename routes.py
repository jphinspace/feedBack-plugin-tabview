"""Tab View plugin — serves Guitar Pro files converted from arrangements."""

import sys
import tempfile
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import Response

# Ensure the song lib is importable
_lib = str(Path(__file__).resolve().parent.parent.parent / "lib")
if _lib not in sys.path:
    sys.path.insert(0, _lib)

# `sloppak` is loaded lazily inside the song-package branch below — older
# cores ship without lib/sloppak.py, and a top-level import here would
# disable Tab View entirely on those installs.

# Song-package suffixes: `.feedpak` is the current extension, `.sloppak` the
# legacy one — same on-disk format either way (mirrors core lib/sloppak.py
# SONG_EXTS, which can't be imported here without breaking the lazy import).
PAK_EXTS = (".feedpak", ".sloppak")


def setup(app: FastAPI, context: dict):
    get_dlc_dir = context["get_dlc_dir"]
    get_sloppak_cache = context.get("get_sloppak_cache_dir")

    from rs2gp import arrangement_to_gp5

    def _song_to_gp5(song, arrangement: int, overrides=None) -> Response:
        if not song.arrangements:
            return Response("No arrangements found", status_code=404)
        idx = max(0, min(arrangement, len(song.arrangements) - 1))
        gp5_bytes = arrangement_to_gp5(song, idx, overrides=overrides)
        return Response(
            content=gp5_bytes,
            media_type="application/octet-stream",
            headers={"Content-Disposition": 'attachment; filename="tab.gp5"'},
        )

    # Validated shape-only; rs2gp's per-field casts reject malformed
    # notes/chords, surfacing as the same "Conversion error" 500 as GET.
    def _parse_overrides(body):
        if not isinstance(body, dict):
            return None
        notes = body.get("notes")
        chords = body.get("chords")
        tuning = body.get("tuning")
        string_count = body.get("stringCount")
        if not isinstance(notes, list) or not isinstance(chords, list):
            return None
        if not isinstance(tuning, list) or not tuning:
            return None
        if not isinstance(string_count, int) or isinstance(string_count, bool) or string_count < 1:
            return None
        return {"notes": notes, "chords": chords, "tuning": tuning, "string_count": string_count}

    def _resolve_song_path(filename: str):
        dlc = get_dlc_dir()
        if not dlc:
            return None, None, Response("DLC folder not configured", status_code=500)

        song_path = Path(dlc) / filename

        # Path traversal guard: reject any filename that resolves outside dlc.
        dlc_resolved = Path(dlc).resolve()
        try:
            resolved = song_path.resolve()
        except Exception:
            return None, None, Response("Path resolution failed", status_code=400)
        if resolved != dlc_resolved and dlc_resolved not in resolved.parents:
            return None, None, Response("Path traversal not allowed", status_code=400)

        if not song_path.exists():
            return None, None, Response("File not found", status_code=404)

        return song_path, dlc, None

    def _load_and_convert(filename: str, arrangement: int, overrides) -> Response:
        song_path, dlc, err = _resolve_song_path(filename)
        if err:
            return err

        try:
            # Song package (zip-form *.feedpak / *.sloppak or directory-form
            # ending in either suffix): use the sloppak loader directly — it
            # accepts both extensions. Only directories whose name ends with
            # a package suffix are treated as packages; any other input is
            # rejected with a clear error below.
            is_pak = filename.lower().endswith(PAK_EXTS) or (
                song_path.is_dir() and song_path.name.lower().endswith(PAK_EXTS)
            )
            if is_pak:
                try:
                    import sloppak as sloppak_mod
                except ImportError:
                    return Response(
                        "Sloppak support requires a newer feedBack core (lib/sloppak.py). "
                        "Update the host.",
                        status_code=501,
                    )
                raw_cache = get_sloppak_cache() if get_sloppak_cache else None
                cache = Path(raw_cache) if raw_cache is not None else Path(tempfile.gettempdir()) / "sloppak_cache"
                cache.mkdir(parents=True, exist_ok=True)
                loaded = sloppak_mod.load_song(filename, Path(dlc), cache)
                return _song_to_gp5(loaded.song, arrangement, overrides)

            # Any non-package input is unsupported.
            return Response(
                "Only .feedpak / .sloppak songs are supported",
                status_code=400,
            )
        except Exception as e:
            import traceback
            traceback.print_exc()
            return Response(f"Conversion error: {e}", status_code=500)

    @app.get("/api/plugins/tabview/gp5/{filename:path}")
    def tabview_gp5(filename: str, arrangement: int = 0):
        return _load_and_convert(filename, arrangement, None)

    @app.post("/api/plugins/tabview/gp5/{filename:path}")
    async def tabview_gp5_transformed(filename: str, request: Request, arrangement: int = 0):
        try:
            body = await request.json()
        except Exception:
            return Response("Invalid JSON body", status_code=400)
        overrides = _parse_overrides(body)
        if overrides is None:
            return Response("Invalid chart-transform override payload", status_code=400)
        return _load_and_convert(filename, arrangement, overrides)
