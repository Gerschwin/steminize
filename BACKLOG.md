# Batched changes (not yet built)

(nothing waiting)

Parked: band collaboration "Session mode" (watch a synced folder, versions, comments). Decided it doesn't belong in a separation app: better as DAW scripts (Reaper/Ardour Lua export + import) plus Syncthing. Revisit only if the band shares parts via a folder + Open multitrack for a few weeks.

Scrolling tab in time with the recording ("tab+"): manually-typed tab (the Scratchpad's Tab pane), not auto-transcribed — see the line below about why that's not planned. Tab doesn't have lyrics' one-line-per-moment structure (a tab "line" is several stacked string-rows per bar, and useful granularity is per-column/beat, not per line), so the existing LRC lyrics-follow mechanism can't just be reused as-is. Design sketch (2026-09-29):
- Data model: anchors as `{charOffset, time}` pairs (same shape as the existing markers' `{pos, name}`, just keyed into text instead of only time) — a new `ScratchState.tabAnchors?` array alongside the existing `tab` field.
- Note-level timing without tapping every note: tab is monospace specifically because column position implies rhythm, so interpolate scroll *linearly by character offset* between two time-anchored points, not just by time. A handful of per-bar taps then gets most of the note-level feel for free, for any reasonably evenly-spaced tab; tapping more anchors (down to individual notes) trades more effort for more precision — the mechanism doesn't care about granularity, it scales either way.
- Display: a second, read-only view toggled by a "Follow along" button, same pattern as lyrics-follow — auto-scrolls to keep the current bar-block visible, highlights it, and (with note-level anchors) sweeps a thin cursor across the block in sync, like a DAW playhead over text.
- Anchor-setting UI: reuse the Tap-tempo button's interaction (tap at each bar-start during playback) plus the lyrics pane's existing nudge (−/+) controls for fixing drift after the fact.
- Scroll speed still needs to run through the same tempo-adjustment math lyrics-follow already has, so it tracks correctly when the song is slowed down.
Real feature (new data model + anchor-editing UI + a new render mode), not a small extension of lyrics-follow; needs a manual sync pass per song like LRC lyrics already do.

Transcription, not planned: guitar tab (string/fret guessing is poor) and sheet music (needs a big notation library; automatic rhythms need too much fixing).

GPU support on Linux (WebKitGTK): currently only mitigated (avoid loading the GPU path unless a GPU is actually usable; a warning icon next to the backend chip in main.ts if it's used anyway), not fixed. Root cause is WebKitGTK's WebGPU implementation itself (the asyncify WASM build onnxruntime-web uses for it misbehaves there — the earlier OOM crash), not something app code can truly patch. Researched 2026-09-29: WASM's JSPI (JavaScript Promise Integration) is meant to replace asyncify for this and just landed in WebKit — Safari 27 beta, 2026 — but two gaps remain before it'd help here: WebKitGTK (Linux) typically trails Safari's WebKit release by months or more, and onnxruntime-web's JSPI work so far targets Node.js/React Native, not the browser WebGPU execution provider this app actually uses (no sign of a browser/JSPI option in its docs). Not close. Real near-term fix, if this ever matters enough: bypass in-browser WebGPU entirely and run GPU inference natively in Rust (`wgpu` or ONNX Runtime's Rust bindings) via Tauri IPC — a genuine architecture change to the separation engine, not a quick task. Revisit if WebKitGTK or onnxruntime-web news changes; not worth starting speculatively.

Possible UI change: pin the drop zone (+ Songs/Settings tabs, already sticky) at the top of the left pane so "add a song" is always in view, letting only the Library/Setlist area scroll underneath — same idea as the deck-top/lanes split on the right. Smaller win than the right pane though: the Library card already caps itself at a 260px internal scroll, so it doesn't blow out the page the way an open song's lane count does; what mostly drives `.side` scrolling is a short window height, not song count, and pinning the full static block (drop zone, "Open multitrack/folder" buttons, format row) would eat a chunk of a short viewport permanently. Only worth doing if it turns out to be an actual annoyance, not proactively.

## Done
- [x] Live input (record yourself over the track), Tuner, Setlist mode, Scratchpad practice notes per song — all built since v1.12.1, not yet released (unreleased)
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
