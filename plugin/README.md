# Steminize Player (plugin)

A plugin that plays a Steminize song's stems **inside your DAW**, in time with the DAW's transport, so the DAW can do what it is good at
(live monitoring and recording) while Steminize does the stems. Licensed **GPL-3.0-or-later** (see `LICENSE`): the VST3 bindings the
plugin framework ([nih-plug](https://github.com/robbert-vdh/nih-plug)) uses are GPLv3. The Steminize app itself stays MIT.

**Status: first working version (0.1.0).** It loads in Ardour, plays the stems in sync with the transport, and has the mix and each stem
on its own output. There is no window yet and it does not yet follow the DAW's tempo: see "Not yet".

## What it does
- **Plays in time with the DAW.** Wherever the DAW's playhead is, the plugin plays that moment of the song. Starting, stopping,
  looping and jumping all stay in step, because every block of audio is worked out from the playhead position alone.
- **A lead-in.** Steminize's Send to DAW puts the stems after a short silent lead-in (under one bar) so the song's first bar lands on a
  bar line; the song file records it and the plugin starts the stems that far into the timeline.
- **Outputs.** One stereo **Mix** output plus **eight stem outputs** (Stem 1 to Stem 8, in the order the song lists them), so a stem can
  be routed to its own track in the DAW.
- **Controls (automatable).** Master level, **Offset** (±500 ms, to nudge the song into step), and for each stem a **level**, **mute** and
  **solo**. Mute and solo apply to a stem's own output as well as to the mix.
- **Any sample rate.** The song is converted to the DAW's rate when it is loaded (on a background thread, never in the audio callback).

## Getting a song into it
1. In Steminize, open a song and press **Send to DAW…**. Any of the options writes `steminize-song.json` beside the stems (except the
   `.dawproject` one, whose audio is inside the file).
2. Tell the plugin where that folder is. Until the window arrives there are two ways: set the environment variable `STEMINIZE_SONG` to the
   folder (or the `steminize-song.json` file) before starting the DAW, or put the path on the first line of
   `~/.config/steminize/plugin-song.txt`.
3. Put the plugin on an instrument track (or a track with no input), press play.

## Building and installing (Linux, macOS, Windows)
```sh
cd plugin
cargo test                                  # the logic: mixing, loading, the song file
cargo xtask bundle steminize_player --release   # builds target/bundled/steminize_player.vst3
```
Copy `target/bundled/steminize_player.vst3` to `~/.vst3/` (Linux), `~/Library/Audio/Plug-Ins/VST3/` (macOS) or
`C:\Program Files\Common Files\VST3\` (Windows), and rescan plugins in the DAW. Needs a recent Rust toolchain; no other libraries.

## How it was checked
- `cargo test`: the mixing (positions, lead-in, ends of stems, mute / solo / levels / pan, loops and jumps give identical audio),
  loading (16, 24 and 32-bit WAV, mono, resampling a sine, errors), and the song file.
- **Ardour 9.7 scanned it** (`ardour-vst3-scanner`: found "Steminize Player", no inputs, a stereo output and eight stereo aux outputs).
- **Ardour 9.7 rendered it** (`ardour9-export` on a session with the plugin on a track): audio began at exactly 1.198 s (the lead-in), and
  the bass at level 0.8 panned halfway left came out at 0.4 left and 0.2 right, with the drums' left and right content in place.
- Not tried in Reaper, Bitwig, Studio One or Cubase, on Windows or macOS, or with the DAW's transport looping live.

## Not yet (in the order I would do them)
1. **A window**: choose the song, see the stems with their names and faders, the host tempo against the song's, and apply Steminize's
   mute / solo settings (the song file records them; the plugin does not apply them yet, so every stem starts unmuted).
2. **Follow the DAW's tempo** (time-stretch, bypassed when the tempos match) and a **key shift**, so slowing the DAW slows the song.
3. Markers as a list to jump to, and awareness of the DAW's loop.
4. CLAP as well as VST3, Windows and macOS builds in CI, an installer.
5. Loading a song straight from the Steminize app's library.
