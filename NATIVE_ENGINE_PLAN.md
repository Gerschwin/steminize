# Native audio engine: plan (branch `native-audio`)

Goal: playing, practising and recording through the sound card's own driver with small buffers, instead of the
webview's web audio (about 240 ms round trip measured through the webview on Linux with a USB interface, 10.6 ms
through PipeWire with the native proof of concept). Desktop app only. The web audio path stays as the fallback and as the
browser version, selectable in a "Native audio" setting.

## Decisions

- **One native stream for everything.** The song, the click and your instrument go through a single set of cpal streams
  owned by Rust, so recording has an exactly known relationship to playback.
- **The TypeScript engine stays the reference.** `src/player/{mixcore,eq,transport}.ts` are the web fallback, and the
  Rust port in `src-tauri/src/engine/` is checked against them (golden values in the Rust tests).
- **Time-stretch / pitch: `signalsmith-stretch`** (MIT). SoundTouch (what the web player uses) is LGPL, which does not
  sit well statically linked into an MIT binary. It will sound slightly different, probably better on full mixes.
- **Hosts:** ALSA (includes PipeWire / PulseAudio through their ALSA devices) first, Core Audio and WASAPI come with cpal
  on macOS / Windows, JACK and ASIO later and optional (see BACKLOG.md for the licensing and runtime-linking caveats).
- **Songs reach the engine as files, not through IPC.** A 4-minute 6-stem song is roughly 500 MB of floats; pushing that
  across the webview boundary would be slow and memory-hungry. The native library already stores stems on disk, so Rust
  decodes them itself. A song not yet in the library is written to a temp file first.

## Stages

1. **Proof of concept (done).** cpal monitor and loopback test in the Live input drawer. 10.6 ms round trip.
2. **Engine core in Rust (done 2026-10-04).** `engine/{eq,mix,renderer,transport}.rs`: gains, pan, EQ, loop passes,
   gap, count-in, click, speed trainer, tempo / pitch via the stretcher. 23 tests including a sample-for-sample match with
   the TypeScript mixer.
3. **Native playback (done 2026-10-04).** `src-tauri/src/native_playback.rs`. Verified end to end on a real library song
   (Rust test through a PipeWire null sink: sound while playing, silence on pause, position exact) and in the running
   desktop app under a virtual display (play, seek, tempo 90%, position reports driving the playhead).
   Original description: Decode stems from the library files (symphonia: FLAC / WAV / MP3), run the transport inside the
   cpal output callback with lock-free commands in (play, pause, seek, loop, tempo, pitch, gains, practice) and position
   reports out (about 30 per second, over a Tauri event). Output only, no input yet.
4. **UI adapter (first version done 2026-10-04).** `Player` routes to the native commands when "Use native playback" is
   ticked in the Native audio panel and the song is saved in the library; unsaved songs and everything else (monitor,
   recording, tuner tones, scrub grains) still use the web audio. Takes added or switched while a song plays are sent as raw
   bytes. Not done: switching a song that is already open, an explicit device-lost recovery.
   Original description: Extract a `Player` interface from `src/player/player.ts` (what `deck.ts` calls today), keep the web
   implementation, add a native one that forwards to the Tauri commands, and a "Native audio" setting that picks one.
   Waveform drawing, markers, tab follow-along and the trainer keep working because they read the same position state.
5. **Native live input and recording (done 2026-10-04).** `src-tauri/src/native_input.rs` + `native_playback.rs`. The input
   stream joins the engine: monitor (level, pan, queue kept to about one block), level meter, a snapshot for the tuner and the
   tab Trainer, and recording with the measured round trip taken off. Verified two ways through a PipeWire null sink as a
   perfect loopback: a Rust test (take 0.34 ms from the song) and a take recorded through the real app UI, saved, and compared
   with the song (1.1 ms). Native has its own latency value (default 10 ms; Measure / Loopback test sets it) and the old
   Line up tool still works on native takes. Web fallback unchanged.
   Original description: The input stream feeds the monitor and a recorder in the same callback as the
   playback, so the take's offset against the song is known exactly (no Measure, no Line up needed). Takes are written
   out as files and added as takes the way web takes are.
6. **Hardening.** Device hot-unplug, sample-rate mismatches, xrun counters in the UI, a buffer size setting, then
   Windows and macOS builds in CI, then optional JACK / ASIO.

## Known costs and risks

- Large: the playback engine, its commands, the UI adapter and recording are each real work, and the first listening tests
  need a person with the real interface.
- `signalsmith-stretch` builds C++ and needs libclang at build time (bindgen); CI runners have it.
- Only Linux can be tested here. Windows / macOS compile in CI and need a person to try them.
- Position reported to the UI lags the audible position by the stretcher's latency when tempo != 1; to be compensated.
