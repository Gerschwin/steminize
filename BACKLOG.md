# Batched changes (not yet built)

(nothing waiting)

Parked: band collaboration "Session mode" (watch a synced folder, versions, comments). Decided it doesn't belong in a separation app: better as DAW scripts (Reaper/Ardour Lua export + import) plus Syncthing. Revisit only if the band shares parts via a folder + Open multitrack for a few weeks.

Ideas not yet chosen: record yourself over the track, tuner, setlists, practice notes per song.

Scrolling tab in time with the recording: manually-typed tab (the Scratchpad's Tab pane), not auto-transcribed — see the line above about why that's not planned. Tab doesn't have lyrics' one-line-per-moment structure (a tab "line" is several stacked string-rows per bar, and useful granularity is per-column/beat, not per line), so the existing LRC lyrics-follow mechanism can't just be reused as-is. Most practical approach discussed: tap along to mark bar-starts while playing (like the existing Tap-tempo button/markers), store those as timestamp anchors against character positions in the tab, and interpolate scroll between anchors — running through the same tempo-adjustment math the lyrics follow-along needs so scroll speed still tracks when the song is slowed down. Real feature (new data model + tap-align UI + interpolated scroll), not a small extension of lyrics-follow; needs a manual sync pass per song like LRC lyrics already do.

Transcription, not planned: guitar tab (string/fret guessing is poor) and sheet music (needs a big notation library; automatic rhythms need too much fixing).

## Done
- [x] Transcription tools: notes view with keyboard, freeze, editable chord lane + chord chart, audio to MIDI with Basic Pitch (v1.10.0)
- [x] Linux desktop fixes from first AppImage testing: "Open folder…" used Tauri's native folder dialog instead of the unsupported `webkitdirectory` picker; window opens maximised to the screen instead of a fixed 1280×860; a stuck "Reading audio…" (missing GStreamer codecs) now times out with a clear error instead of hanging forever (v1.9.1)
- [x] Library backup/restore: back up every song (stems + settings) as one zip, restore into any browser/install; songs already present are skipped, not duplicated (v1.9.0)
- [x] Open multitrack / open folder (v1.7.0)
- [x] Section markers, foot pedal control, key detection, waveform zoom (v1.6.0)
- [x] Library: keep separated songs + settings between sessions (v1.5.0)
- [x] Speed trainer (v1.5.0)
- [x] Loop gap and count-in (v1.5.0)
- [x] Tempo/beat detection, click track, snap to beats/bars (v1.5.0)
- [x] Per-stem EQ behind an **EQ** button (lights up when active): presets (Kick, Snare, Hi-hats, Bass on small speakers, Vocal clarity, Flat) plus manual low-cut, high-cut and one sweepable focus band (boost/cut, max +12 dB). Applies to playback and Export mix. (v1.4.0)
- [x] Hide the Pan slider behind a toggle, off by default. (v1.3.0)
- [x] "Pause after current song" option. (v1.3.0)
- [x] Re-run uses the settings at the moment you click it (same mechanism as above). (v1.3.0)
- [x] Lock each song's settings when it's added, and label the queue entry with them (e.g. "Fine-tuned · vocals/rest"), so the same song can be queued with different settings to compare. (v1.3.0)
- [x] Auto-start switch in the queue header (remembered); when off, show a **Start** button. (v1.3.0)
- [x] Time taken + elapsed timer (v1.1.0)
- [x] Version label (v1.1.0)
- [x] Per-stem pan (v1.2.0)
