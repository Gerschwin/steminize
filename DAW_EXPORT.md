# Send to DAW

**Send to DAW…** (next to Export mix, above a song) opens the song in a recording program, so a DAW can do the live monitoring and
recording it is built for, while Steminize does the stems, tempo and markers. It saves a folder (a ZIP in the browser).

## What every export contains
- **The stems as separate audio files** (WAV, in the bit depth set under Output format), one per track as it is in Steminize, including
  any recorded takes that are showing. Your **levels, pan, mute and solo** are carried over; EQ is not.
- **The tempo and bars.** Steminize detects the tempo and where the bars start (Tempo & key). The project uses that tempo and bar
  length (for example 120 BPM in 4/4), and the song's **first bar lands on a bar line**. To make that work the stems sit after a short
  silent lead-in, always under one bar, so bar numbers in the DAW match the music.
- **Markers** (your section markers, and the loop as "Loop start" / "Loop end"), as a list (`markers.csv`) and inside the tempo map.
- **`tempo-map.mid`:** a MIDI file with only the tempo, the bar length and the markers, to import as a tempo map.
- **`tempo-map-follows-the-beats.mid`** (only if the song's tempo drifts): the same, with a tempo change at every beat so the grid
  follows a performance that speeds up and slows down. Use it instead of the steady one if the grid slides away from the music.
- **`README.txt`** saying what was found and how to open it.

If no tempo has been detected for the song the grid is a plain 120 BPM and will not match the music: open Tempo & key first.

## Per program
| Program | What you get | How to open it |
|---|---|---|
| **Reaper** | A ready-made project (`.rpp`): one track per stem with its level, pan, mute and solo and colour, the tempo and bars, markers, and the loop as the time selection. The audio files are untouched; the project places them after the lead-in. | Open the `.rpp` (keep the audio files beside it). |
| **Ardour** (8 or later) | A ready-made **session folder**: one stereo track per stem with its name, colour, level, pan, mute and solo, the audio regions placed after the lead-in, the tempo and bar length, your markers, and the loop. The audio is inside the session (`interchange/<name>/audiofiles`). | Session → Open, and pick the `.ardour` file. If you hear nothing, connect the Master outputs in Window → Audio Connections. |
| **Logic, Pro Tools, Cubase, Ableton, Studio One, Bitwig and others** | The audio files **with the lead-in built in**, so they all line up when dropped in at the very start of the project, plus `tempo-map.mid` and `markers.csv`. | New project, set the tempo and bar length from the README, drag the files in at the start. Import `tempo-map.mid` as the tempo map if the program can (Logic: File → Import → Tempo map; Pro Tools: Import Session Data → tempo map; Ardour users should use the Ardour option instead). |

## How the Ardour session was checked
Ardour has no published description of its session file, so the export is built on what Ardour itself writes: a new session made with
`ardour9-new_session` is the skeleton, and a plain stereo track from a real Ardour 9.7 session is the track template (`tools/make-ardour-template.py`
captures both into `src/export/ardourTemplate.ts`; only the structure is kept). It was checked with **Ardour 9.7.0** itself, by loading and rendering:
- `ardour9-export` rendered an exported session without error. The render had silence for exactly the lead-in, then each stem in the right
  channels, the muted stem absent, and the right level and pan (a stem at level 0.8 panned halfway left came out at 0.4 left / 0.2 right).
- `ardour9-lua` read back the tracks (names, gain, mute), the markers, the loop (3.2 to 7.2 s), the session range, the tempo (120.1) and the bar length.
- The same check was run on a session written by the real app (ZIP, unzipped), not only the test code.
Not checked: Ardour 8.x (the session version is 7003, which Ardour 8 and 9 both write), and playing it on a real sound card (the
Master outputs are saved as connected to `system:playback_1/2`; if your setup names them differently, connect them by hand).

## What it is not
- It is not live: Steminize and the DAW are separate. Change the tempo or key in Steminize, then send again (or use **Export mix** to
  render a slowed or re-keyed mix).
- Tempo and pitch changes made in Steminize are **not** applied to the stems that are sent: they are the original stems.
- It does not play along or sync with the DAW's transport. A live link (audio sent into the DAW and MIDI clock for the transport) is on the backlog.

## How it works (for the code)
`src/export/ardour.ts` writes the Ardour session. `src/export/daw.ts` holds the shared logic and is tested: bar alignment (`barAlignment`), per-beat tempos (`beatTempos`), the Reaper project
(`reaperProject`), the marker list, the tempo-map MIDI (`writeMidiTempoMap` in `src/encode/midi.ts`) and the README. The deck
(`sendToDaw` in `src/ui/deck.ts`) gathers the song and writes the files.
