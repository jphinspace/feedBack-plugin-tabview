"""arrangement_to_gp5's `overrides` param: notes/chords/tuning/stringCount
must drive the conversion instead of arr.notes/arr.chords/arr.tuning, while
measures/tempo/metadata keep coming from song/arr. Round-trips through the
real pyguitarpro writer/reader so a wrong mapping shows as a parse mismatch."""

import io
from types import SimpleNamespace

import guitarpro
import rs2gp


def make_beats(n=8, interval=0.5):
    return [SimpleNamespace(time=i * interval, measure=0 if i == 0 else -1) for i in range(n)]


def make_song(arr, beats=None, song_length=4.0, title="Title", artist="Artist", album="Album"):
    return SimpleNamespace(
        arrangements=[arr],
        beats=beats if beats is not None else make_beats(),
        song_length=song_length,
        title=title,
        artist=artist,
        album=album,
    )


def make_arr(name="Lead", path_bass=False, tuning=None, notes=None, chords=None):
    return SimpleNamespace(
        name=name,
        path_bass=path_bass,
        tuning=tuning if tuning is not None else [0, 0, 0, 0, 0, 0],
        notes=notes if notes is not None else [],
        chords=chords if chords is not None else [],
    )


def parse_gp5(gp5_bytes):
    return guitarpro.parse(io.BytesIO(gp5_bytes))


def test_overrides_absent_behaves_as_before():
    arr = make_arr(tuning=[0, 0, 0, 0, 0, 0], notes=[
        SimpleNamespace(string=0, fret=3, sustain=0.0, time=0.0, slide_to=-1, bend=0.0,
                        hammer_on=False, pull_off=False, harmonic=False, harmonic_pinch=False,
                        palm_mute=False, mute=False, tremolo=False, accent=False, tap=False),
    ])
    song = make_song(arr)
    gp = parse_gp5(rs2gp.arrangement_to_gp5(song, 0))
    track = gp.tracks[0]
    assert len(track.strings) == 6
    # RS string 0 (lowest) -> gp string 6 (num_strings - 0).
    assert track.measures[0].voices[0].beats[0].notes[0].string == 6
    assert track.measures[0].voices[0].beats[0].notes[0].value == 3


def test_overrides_replace_notes_chords_tuning_and_string_count():
    # arr carries a different, stale chart so a wiring bug would show up.
    arr = make_arr(
        tuning=[0, 0, 0, 0, 0, 0],
        notes=[SimpleNamespace(string=0, fret=99, sustain=0.0, time=0.0, slide_to=-1, bend=0.0,
                                hammer_on=False, pull_off=False, harmonic=False, harmonic_pinch=False,
                                palm_mute=False, mute=False, tremolo=False, accent=False, tap=False)],
    )
    song = make_song(arr)

    overrides = {
        "notes": [{"t": 0.0, "s": 0, "f": 5}],
        "chords": [],
        "tuning": [2, 0, 0, 0, 0, 0],  # retuned: lowest string up 2 semitones
        "string_count": 6,
    }
    gp = parse_gp5(rs2gp.arrangement_to_gp5(song, 0, overrides=overrides))
    track = gp.tracks[0]

    beat = track.measures[0].voices[0].beats[0]
    assert len(beat.notes) == 1
    assert beat.notes[0].string == 6  # RS string 0 -> gp string (6 - 0)
    assert beat.notes[0].value == 5   # override fret, not arr's 99

    # GUITAR_STANDARD[5] (gp_idx=5, the lowest GP string) is 40; tuning[0]=2 -> 42.
    lowest_string = next(s for s in track.strings if s.number == 6)
    assert lowest_string.value == 42


def test_overrides_change_string_count():
    arr = make_arr(tuning=[0, 0, 0, 0, 0, 0])  # stale 6-string arr tuning
    song = make_song(arr)
    overrides = {
        "notes": [{"t": 0.0, "s": 0, "f": 0}],
        "chords": [],
        "tuning": [0, 0, 0, 0],
        "string_count": 4,  # e.g. a transform that retunes to a 4-string profile
    }
    gp = parse_gp5(rs2gp.arrangement_to_gp5(song, 0, overrides=overrides))
    assert len(gp.tracks[0].strings) == 4


def test_overrides_do_not_affect_measures_tempo_or_metadata():
    arr = make_arr(name="Bass", path_bass=True)
    song = make_song(arr, beats=make_beats(n=8, interval=0.25), title="My Song", artist="Someone")
    overrides = {"notes": [], "chords": [], "tuning": [0, 0, 0, 0, 0, 0], "string_count": 6}

    plain = parse_gp5(rs2gp.arrangement_to_gp5(song, 0))
    transformed = parse_gp5(rs2gp.arrangement_to_gp5(song, 0, overrides=overrides))

    assert transformed.title == plain.title == "My Song"
    assert transformed.artist == plain.artist == "Someone"
    assert len(transformed.tracks[0].measures) == len(plain.tracks[0].measures)
    assert transformed.tempo == plain.tempo


def test_overrides_chord_notes_decode_through_wire_format():
    arr = make_arr()
    song = make_song(arr)
    overrides = {
        "notes": [],
        "chords": [{"t": 0.0, "hd": False, "notes": [{"s": 0, "f": 2}, {"s": 5, "f": 0}]}],
        "tuning": [0, 0, 0, 0, 0, 0],
        "string_count": 6,
    }
    gp = parse_gp5(rs2gp.arrangement_to_gp5(song, 0, overrides=overrides))
    beat = gp.tracks[0].measures[0].voices[0].beats[0]
    strings_played = {n.string for n in beat.notes}
    assert strings_played == {6, 1}  # RS string 0 -> gp 6, RS string 5 -> gp 1
