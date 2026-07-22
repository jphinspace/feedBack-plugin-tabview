"""routes.py wiring: path-traversal guard shared by GET/POST, and the POST
override payload, through the real FastAPI app + pyguitarpro. Uses a fake
`sloppak` module so only routes.py's own request handling is under test."""

import sys
import types
from pathlib import Path
from types import SimpleNamespace

import guitarpro
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes


def make_song():
    beats = [SimpleNamespace(time=i * 0.5, measure=0 if i == 0 else -1) for i in range(8)]
    arr = SimpleNamespace(
        name="Lead", path_bass=False, tuning=[0, 0, 0, 0, 0, 0],
        notes=[SimpleNamespace(string=0, fret=1, sustain=0.0, time=0.0, slide_to=-1, bend=0.0,
                                hammer_on=False, pull_off=False, harmonic=False, harmonic_pinch=False,
                                palm_mute=False, mute=False, tremolo=False, accent=False, tap=False)],
        chords=[],
    )
    return SimpleNamespace(arrangements=[arr], beats=beats, song_length=4.0,
                            title="T", artist="A", album="Al")


@pytest.fixture
def app_and_dlc(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    song_pkg = dlc / "song.feedpak"
    song_pkg.write_bytes(b"not a real package; sloppak is faked below")

    fake_sloppak = types.ModuleType("sloppak")
    fake_sloppak.load_song = lambda filename, dlc_path, cache: SimpleNamespace(song=make_song())
    monkeypatch.setitem(sys.modules, "sloppak", fake_sloppak)

    app = FastAPI()
    context = {
        "get_dlc_dir": lambda: str(dlc),
        "get_sloppak_cache_dir": lambda: str(tmp_path / "cache"),
    }
    routes.setup(app, context)
    return TestClient(app), dlc


def test_get_converts_without_overrides(app_and_dlc):
    client, _ = app_and_dlc
    resp = client.get("/api/plugins/tabview/gp5/song.feedpak")
    assert resp.status_code == 200
    gp = guitarpro.parse(__import__("io").BytesIO(resp.content))
    assert gp.tracks[0].measures[0].voices[0].beats[0].notes[0].value == 1  # arr's fret


def test_post_overrides_replace_the_converted_chart(app_and_dlc):
    client, _ = app_and_dlc
    resp = client.post(
        "/api/plugins/tabview/gp5/song.feedpak",
        json={
            "notes": [{"t": 0.0, "s": 0, "f": 9}],
            "chords": [],
            "tuning": [0, 0, 0, 0, 0, 0],
            "stringCount": 6,
        },
    )
    assert resp.status_code == 200
    gp = guitarpro.parse(__import__("io").BytesIO(resp.content))
    assert gp.tracks[0].measures[0].voices[0].beats[0].notes[0].value == 9  # override fret, not arr's 1


@pytest.mark.parametrize("body", [
    {},
    {"notes": "nope", "chords": [], "tuning": [0], "stringCount": 6},
    {"notes": [], "chords": [], "tuning": [], "stringCount": 6},
    {"notes": [], "chords": [], "tuning": [0], "stringCount": 0},
    {"notes": [], "chords": [], "tuning": [0], "stringCount": True},
])
def test_post_rejects_malformed_overrides(app_and_dlc, body):
    client, _ = app_and_dlc
    resp = client.post("/api/plugins/tabview/gp5/song.feedpak", json=body)
    assert resp.status_code == 400


def test_post_path_traversal_rejected_same_as_get(app_and_dlc):
    # %2e%2e survives httpx's URL normalization; a literal ".." wouldn't.
    client, _ = app_and_dlc
    body = {"notes": [], "chords": [], "tuning": [0], "stringCount": 6}
    get_resp = client.get("/api/plugins/tabview/gp5/%2e%2e%2fetc%2fpasswd")
    post_resp = client.post("/api/plugins/tabview/gp5/%2e%2e%2fetc%2fpasswd", json=body)
    assert get_resp.status_code == post_resp.status_code == 400


def test_post_missing_file_404s(app_and_dlc):
    client, _ = app_and_dlc
    body = {"notes": [], "chords": [], "tuning": [0], "stringCount": 6}
    resp = client.post("/api/plugins/tabview/gp5/nope.feedpak", json=body)
    assert resp.status_code == 404
