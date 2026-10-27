#!/usr/bin/env python3
"""Builds the example song: three synthesised stems (Guitar, Bass, Drums), a finished guitar tab and the taps that time it.

Everything is generated here (nothing is sampled or copied), so the song can be shipped or shared freely. The guitar audio and the
tab text come from the same list of notes, so they agree to the sample.

    python3 tools/make-example-song.py <library folder> [--check notes.json]

<library folder> is the app's library (for example ~/.local/share/app.steminize.desktop/library); the song goes in a new folder there.
--check writes the note times the tab is meant to have, for tests/check-example-song.mjs to compare with what the app reads from it.
"""
import json, math, os, subprocess, sys, time
import numpy as np

SR = 44100
BPM = 100
BEAT = 60 / BPM
BAR = 4 * BEAT
LEAD = BAR  # one bar of count-in before the tab starts
S16 = BEAT / 4

# Strings, thinnest first, with the MIDI note of the open string.
STRINGS = [("e", 64), ("B", 59), ("G", 55), ("D", 50), ("A", 45), ("E", 40)]
IDX = {n: i for i, (n, _) in enumerate(STRINGS)}

# A chord is (root string, root fret) and three upper notes. The verse arpeggiates it in eighths: root, a, b, c, b, a, b, c.
CHORDS = {
    "Am": ((("A", 0)), (("D", 2)), (("G", 2)), (("B", 1))),
    "F": ((("E", 1)), (("D", 3)), (("G", 2)), (("B", 1))),
    "C": ((("A", 3)), (("D", 2)), (("G", 0)), (("B", 1))),
    "G": ((("E", 3)), (("A", 2)), (("D", 0)), (("B", 0))),
}
PROG = ["Am", "F", "C", "G", "Am", "F", "G", "Am"]
ROOT_HZ = {"Am": 55.0, "F": 43.65, "C": 65.41, "G": 49.0}
BASS_PROG = ["Am", "F", "C", "G", "Am", "F", "G", "Am"]

# Each note: (start in sixteenths, length in sixteenths, string, fret, hammer-on target fret or None)
def verse_bar(chord):
    r, a, b, c = CHORDS[chord]
    order = [r, a, b, c, b, a, b, c]
    return [(i * 2, 2, s, f, None) for i, (s, f) in enumerate(order)]

LEAD_BARS = [
    # Am
    [(0, 4, "e", 5, None), (4, 2, "e", 3, None), (6, 2, "e", 5, None), (8, 4, "e", 8, None), (12, 4, "e", 5, None)],
    # F
    [(0, 4, "e", 1, None), (4, 2, "B", 1, None), (6, 2, "e", 5, None), (8, 8, "e", 1, None)],
    # C
    [(0, 2, "e", 0, 3), (4, 2, "e", 0, None), (6, 2, "e", 3, None), (8, 4, "B", 1, None), (12, 4, "e", 3, None)],
    # G
    [(0, 4, "B", 0, None), (4, 2, "e", 3, None), (6, 2, "B", 0, None), (8, 8, "G", 0, None)],
    # Am, higher
    [(0, 2, "e", 5, None), (2, 2, "e", 8, None), (4, 4, "e", 10, None), (8, 4, "e", 8, None), (12, 4, "e", 5, None)],
    # F
    [(0, 4, "e", 8, None), (4, 2, "e", 5, None), (6, 2, "e", 1, None), (8, 4, "e", 5, None), (12, 4, "B", 1, None)],
    # G
    [(0, 2, "B", 3, None), (2, 2, "e", 3, None), (4, 4, "B", 3, None), (8, 4, "B", 0, None), (12, 4, "G", 0, None)],
    # Am, the last note rings
    [(0, 16, "e", 5, None)],
]

BARS = [verse_bar(c) for c in PROG] + LEAD_BARS  # sixteen bars: eight of arpeggio, eight of lead
LETTER = {16: "w", 8: "h", 4: "q", 2: "e", 1: "s"}


def hz(string, fret):
    return 440.0 * 2 ** ((dict(STRINGS)[string] + fret - 69) / 12)


# ---------------------------------------------------------------- the tab text
def build_tab():
    """Writes the tab (four bars to a block, a rhythm line under each so the timing is exact) and records, for every note, the exact
    place it sits in the text, so the taps and the checks can use it."""
    blocks, notes = [], []
    text = ""
    for b0 in range(0, len(BARS), 4):
        rows = {n: n + "|" for n, _ in STRINGS}
        rhythm = "  "
        block_notes = []
        for bi, bar in enumerate(BARS[b0 : b0 + 4]):
            bar_no = b0 + bi
            cells = {n: "-" for n, _ in STRINGS}
            rhy = " "
            for start, ln, s, f, ham in bar:
                col = len(cells["e"])
                tok = str(f) + (f"h{ham}" if ham is not None else "")
                # a hammer-on is two notes: the second sounds where the first one's length ends
                for n, _ in STRINGS:
                    cells[n] += (tok if n == s else "-" * len(tok)) + "--"
                rhy = rhy.ljust(col) + LETTER[ln]
                block_notes.append((bar_no, start, ln, s, f, len(rows["e"]) + col))
                if ham is not None:
                    col2 = col + len(str(f)) + 1
                    rhy = rhy.ljust(col2) + LETTER[ln]
                    block_notes.append((bar_no, start + ln, ln, s, ham, len(rows["e"]) + col2))
            for n, _ in STRINGS:
                rows[n] += cells[n] + "|"
            rhythm += rhy.ljust(len(cells["e"])) + " "
        blocks.append((rows, rhythm.rstrip(), block_notes))
    # Text, with each note's character offset worked out as the text is put together.
    offsets = []
    for rows, rhythm, bn in blocks:
        base = len(text)
        row_start = {}
        pos = base
        for n, _ in STRINGS:
            row_start[n] = pos
            pos += len(rows[n]) + 1
        text += "\n".join(rows[n] for n, _ in STRINGS) + "\n" + rhythm + "\n\n"
        for bar_no, start, ln, s, f, col in bn:
            notes.append({"bar": bar_no, "start": start, "len": ln, "string": s, "fret": f, "offset": row_start[s] + col})
    return text.rstrip("\n"), notes


# ---------------------------------------------------------------- audio
rng = np.random.default_rng(7)


def pluck(freq, seconds, bright=0.5):
    n = int(seconds * SR)
    period = max(2, int(round(SR / freq)))
    buf = rng.uniform(-1, 1, period)
    for _ in range(2):  # soften the first burst so the pick is not harsh
        buf = 0.5 * (buf + np.roll(buf, 1))
    out = np.empty(n)
    decay = 0.9965 if freq < 200 else 0.9945
    prev = 0.0
    for i in range(n):
        j = i % period
        cur = buf[j]
        out[i] = cur
        buf[j] = decay * (bright * cur + (1 - bright) * prev)
        prev = cur
    return out


def env(n, attack=0.004, release=0.06):
    e = np.ones(n)
    a = int(attack * SR)
    r = min(n, int(release * SR))
    e[:a] = np.linspace(0, 1, a)
    e[n - r :] *= np.linspace(1, 0, r)
    return e


def add(track, t, sig):
    i = int(t * SR)
    if i >= len(track):
        return
    sig = sig[: len(track) - i]
    track[i : i + len(sig)] += sig


def guitar_track(total, notes):
    g = np.zeros(int(total * SR))
    for nt in notes:
        t = LEAD + nt["bar"] * BAR + nt["start"] * S16
        ring = min(nt["len"] * S16 * 1.6 + 0.25, 2.6)
        if nt["bar"] == 15:
            ring = 3.2
        sig = pluck(hz(nt["string"], nt["fret"]), ring) * env(int(ring * SR), release=min(0.4, ring / 3))
        # the lead is played harder than the arpeggio
        add(g, t, sig * (0.55 if nt["bar"] < 8 else 0.75))
    # a little warmth: a gentle low-pass by averaging, then a soft clip
    g = np.convolve(g, np.ones(3) / 3, mode="same")
    return np.tanh(g * 1.4) * 0.7


def bass_track(total):
    b = np.zeros(int(total * SR))
    for bar in range(4, 16):  # joins on the fifth bar
        f = ROOT_HZ[BASS_PROG[bar % 8]]
        t0 = LEAD + bar * BAR
        for beat, ln in ((0, 1.4), (1.5, 0.5), (2, 1.4), (3, 0.9)):
            n = int(ln * BEAT * SR)
            x = np.arange(n) / SR
            sig = np.sin(2 * np.pi * f * x) + 0.35 * np.sin(2 * np.pi * 2 * f * x) + 0.12 * np.sin(2 * np.pi * 3 * f * x)
            sig *= np.exp(-x * 2.5) * env(n, 0.006, 0.05)
            add(b, t0 + beat * BEAT, sig * 0.8)
    return np.tanh(b * 1.2) * 0.7


def noise(n):
    return rng.uniform(-1, 1, n)


def kick():
    n = int(0.3 * SR)
    x = np.arange(n) / SR
    f = 45 + 90 * np.exp(-x * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-x * 11) * 0.95


def snare():
    n = int(0.25 * SR)
    x = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 190 * x) * np.exp(-x * 25)
    nz = np.diff(noise(n + 1)) * np.exp(-x * 17)
    return (0.45 * tone + 0.6 * nz) * 0.9


def hat(open_=False, loud=1.0):
    n = int((0.22 if open_ else 0.06) * SR)
    x = np.arange(n) / SR
    nz = np.diff(noise(n + 1))
    return nz * np.exp(-x * (14 if open_ else 70)) * 0.35 * loud


def drum_track(total):
    d = np.zeros(int(total * SR))
    k, s = kick(), snare()
    for q in range(4):  # the count-in bar: hats on the beat
        add(d, q * BEAT, hat(loud=1.6))
    for bar in range(16):
        t0 = LEAD + bar * BAR
        for e in range(8):
            add(d, t0 + e * BEAT / 2, hat(loud=0.6 if bar < 4 else 1.0))
        if bar >= 4:
            for beat in (0, 2):
                add(d, t0 + beat * BEAT, k)
            add(d, t0 + 2.5 * BEAT, k * 0.8)
            for beat in (1, 3):
                add(d, t0 + beat * BEAT, s)
        elif bar == 3:
            add(d, t0 + 3.5 * BEAT, s * 0.5)  # a small fill into the full band
    add(d, LEAD + 16 * BAR, k)
    return np.tanh(d * 1.1) * 0.8


def write_flac(path, mono):
    mono = np.clip(mono, -0.98, 0.98)
    pcm = (mono * 32767).astype("<i2")
    stereo = np.repeat(pcm[:, None], 2, axis=1).tobytes()
    p = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(SR), "-ac", "2", "-i", "-", "-c:a", "flac", path], input=stereo)
    if p.returncode:
        sys.exit("ffmpeg failed")


# ---------------------------------------------------------------- the song
def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    lib = os.path.expanduser(sys.argv[1])
    text, notes = build_tab()
    total = LEAD + 16 * BAR + 3.0
    # times each note should sound at, for the check
    for nt in notes:
        nt["time"] = round(LEAD + nt["bar"] * BAR + nt["start"] * S16, 4)
    if "--check" in sys.argv:
        json.dump({"text": text, "notes": notes, "bpm": BPM, "lead": LEAD}, open(sys.argv[sys.argv.index("--check") + 1], "w"))
        return
    sid = "2026-10-27-example-tab"
    folder = os.path.join(lib, sid)
    os.makedirs(folder, exist_ok=True)
    stems = [("Guitar", guitar_track(total, notes)), ("Bass", bass_track(total)), ("Drums", drum_track(total))]
    for name, sig in stems:
        write_flac(os.path.join(folder, name + ".flac"), sig)
    # A tap at the first note of each block of four bars, all exact. (One tap would do, with the song's own tempo; several make it hold if the song is retimed.)
    anchors = []
    for b0 in range(0, 16, 4):
        n0 = min((n for n in notes if n["bar"] == b0), key=lambda n: (n["start"], IDX[n["string"]]))
        anchors.append({"charOffset": n0["offset"], "time": n0["time"]})
    # and one on the last note, so that nothing lies beyond the final tap (the app holds the last tap's time past it)
    last = max(notes, key=lambda n: (n["bar"], n["start"]))
    anchors.append({"charOffset": last["offset"], "time": last["time"]})
    beats = [round(i * BEAT, 4) for i in range(int(total / BEAT))]
    template = {}
    for cand in sorted(os.listdir(lib)):
        try:
            template = json.load(open(os.path.join(lib, cand, "meta.json"))).get("state") or {}
            if template:
                break
        except Exception:
            pass
    state = json.loads(json.dumps(template))
    state["lanes"] = [{"vol": 1, "pan": 0, "mute": False, "solo": False} for _ in stems]
    state["loop"] = {"on": False, "a": 0, "b": 0}
    state["tempo"] = 1
    state["pitch"] = 0
    state["markers"] = [{"name": "Arpeggio", "pos": int(LEAD * SR)}, {"name": "Lead", "pos": int((LEAD + 8 * BAR) * SR)}]
    state["scratch"] = {"lyrics": "", "tab": text, "notes": "", "tabAnchors": anchors, "tabFollow": True, "tabStaff": False}
    state.pop("practiceSeconds", None)
    state.pop("lastPracticed", None)
    meta = {
        "title": "Example: Am arpeggio and lead (tab filled in and timed)",
        "seconds": round(total, 2),
        "created": int(time.time() * 1000),
        "settings": {"model": "htdemucs_6s", "precision": "compact", "twoStems": "", "skipStems": [], "shifts": 1, "overlap": 0.25, "device": "auto", "format": "wav", "wavDepth": "16", "flacDepth": "16", "mp3Bitrate": 320, "clip": "rescale"},
        "kind": "multitrack",
        "analysis": {"bpm": BPM, "beats": beats, "downbeat": 0, "key": {"tonic": 9, "mode": "minor", "confidence": 0.9}},
        "id": sid,
        "bytes": 0,
        "stems": [{"name": n, "scale": 1} for n, _ in stems],
        "state": state,
    }
    meta["bytes"] = sum(os.path.getsize(os.path.join(folder, n + ".flac")) for n, _ in stems)
    json.dump(meta, open(os.path.join(folder, "meta.json"), "w"))  # last: a folder without it is an incomplete save
    print("wrote", folder, f"({meta['bytes'] // 1024} KB, {total:.1f} s)")


if __name__ == "__main__":
    main()
