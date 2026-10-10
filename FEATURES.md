# Steminize: features

Everything the app does as of 2026-10-10 (branch `native-audio`, version 0.9.4). **Released** means it is in v0.9.3 or earlier; **Released in 0.9.4** means it is new in that pre-release. Ideas that are not built are in `BACKLOG.md`; what 1.0 needs is in `V1_CRITERIA.md`.

Where it works: the desktop app (Windows, macOS, Linux) and the web app (installable on desktop and phone) are the same code. A few features
are desktop only and are marked **[desktop]**.

## Getting audio in
- **Split songs into stems** with Meta's Demucs v4: HT Demucs (fast), HT Demucs Fine-tuned (best, about 4 times slower) and HT Demucs 6-stem (adds guitar and piano; the default). Each comes as a compact (fp16) or full (fp32) download. Released.
- **Demucs options:** two-stem (karaoke) mode, shifts, overlap, clip mode; output as WAV (16, 24 or 32-bit float), FLAC (16 or 24) or MP3 (128–320 kbps). Released.
- **Batch queue:** drop in several songs; each shows progress and time left. Released.
- **Open multitrack:** open separate track files or a whole folder and each becomes a lane, with all the same tools (a shared folder makes this a simple way for a band to share parts). Released.
- **From YouTube [desktop]:** search and download audio into the queue (fetches yt-dlp on first use). Released. The Windows black command window no longer appears: released in 0.9.3.
- **Runs offline** once a model has downloaded; no audio is ever uploaded. WebGPU acceleration where available, otherwise multi-threaded CPU. Released.
- **If the graphics card never loads the model**, it falls back to the CPU after 60 seconds, says so, and remembers; "Loading model…" counts the seconds. Released in 0.9.3.

## Library and sets
- **Library:** separated songs are kept with their mixer, EQ, loop, practice settings, markers, tempo, pitch and notes, and reopen instantly. Released.
- **Back up / restore** the whole library as one zip; restoring skips songs you already have. Released.
- **Setlist:** order songs for a rehearsal or gig; Play setlist, Prev / Next, Auto-advance with a gap (none, 2, 5, 10 s) and countdown; shows each song's key, BPM, speed and loop. Released.

## The practice player
- **Mixer:** mute, solo, level and pan per track; master volume. Released.
- **Per-track EQ** with presets (Kick, Snare, Hi-hats, Bass on small speakers, Vocal clarity) and a manual low-cut, high-cut and focus band. Released.
- **Loops:** Shift-drag across the overview or any track, Set A / Set B, draggable edges, Clear; snapping to beats or bars. Released.
- **Tempo (50–150%) and pitch (±12 semitones)**, independent of each other. Released.
- **Markers and zoom:** named section markers (jump, loop, saved per song); zoom with buttons, scroll wheel or keys; the scroll bar pans. Released.
- **Beat lines on every track** once zoomed in (where the click sounds), bars stronger. Released in 0.9.2.
- **Track tools:** resize a track's height, rename tracks, per-track export button, undo / redo of mixer changes. Released.
- **Tempo and key:** tempo and bar detection from the drum stem, with ½× / 2× / tap correction; key detection with the shifted key shown, other likely keys, and a way to set it yourself. Released.
- **Practice tools:** one-bar count-in, a metronome click that stays in step at any tempo, a gap between loop passes. Released.
- **Speed trainer:** ramps tempo (for example 70% to 100%, +5% each pass); can be gated so it only speeds up when you score well on the tab Trainer. Released.
- **Hands-free:** PageUp / PageDown, foot-pedal mode, media keys and lock-screen controls; the screen stays awake while playing. Released.

## Understanding the music
- **Notes view:** which notes are sounding over time (one row per semitone, E1 to C7), for all parts or one stem, with a keyboard you can click, zoom and play from your computer keyboard. Released.
- **Chord timeline:** a scrolling row of beat boxes in time with the music: the chord shown where it starts, the current beat lit, bar numbers along the top; click a beat to jump to it or a bar number to loop it; zoom the beat width; a **Simple** switch for plain major and minor chords only; follows a pitch shift. Released in 0.9.4.
- **Chord diagrams:** under the timeline, how to play the chord now and the next one (with the number of beats until it) as a guitar or ukulele fingering, or on a piano keyboard; they follow the Simple switch and pitch shift. Released in 0.9.4.
- **Capo:** a Capo setting (1 to 9) shows the timeline and diagrams as the shapes to play with the capo on; **Suggest** picks the capo that makes most of the song open chords. Released in 0.9.4.
- **Freeze:** hold the sound at the playhead as a steady tone. Released.
- **Chords:** detected per beat along the bar grid using the separated bass; click a chord to correct it (corrections are kept per song); **Chart ⤓** saves a text chord chart with your markers as sections, transposed if you've shifted the pitch. Released.
- **To MIDI** (Basic Pitch) for a stem or the whole mix, and **MIDI ⤓** to save one file at the song's tempo. Released.
- **Tuner:** a needle tuner for the live input or any track; follows any pitch shift. Released.

## Playing along and recording
- **Live input:** play an instrument or mic alongside the tracks, with level, pan and a meter; pick the device. Released.
- **Input channel choice** (Stereo, Input 1, Input 2, both summed), which fixes a quiet signal from interfaces that leave one channel empty; the Level slider goes up to 4. Released in 0.9.2.
- **Level 0 for direct monitoring:** recording, the meter, the tuner and the trainer still work with the app's own level turned down. Released in 0.9.2.
- **Record** a take onto a new or existing track, with a lead-in; **Keep last** takes per track, switch between them, add notes, delete; saved with the song. Released.
- **Punch in on loop:** record only across the marked section. Released.
- **Latency tools:** Measure (output patched to an input, or speakers near a mic), a typed value, and **Line up** (nudge a take against the beat lines, then Use as latency). **Low-latency audio** option. Released in 0.9.2.

## Tab and notation (Scratchpad)
- **Five tabs:** Lyrics, Guitar, Bass, Drums, Notes; each song keeps its own text. Released in 0.9.4.
- **Parts:** double-click Guitar / Bass / Drums to rename; a **+** button adds any number of extra parts (second guitar, keys, anything); **Delete part** for ones you added. Released in 0.9.4.
- **Track link:** each part has a **Track** dropdown (defaults to the matching track by name; guitar goes to "other" in a 4-stem split); the linked track is outlined, gets a small **Tab** button that jumps to the tab, and **Play without …** mutes it so you play that part yourself. Works for multitracks. Released in 0.9.4.
- **Tab+ (Guitar, Bass and added parts):** type or paste ASCII tab and tap it in time (one tap is enough with a detected tempo). **Follow along** draws it as engraved notation that scrolls with the music. Released.
  - Notation: rhythm line and time signatures, hammer-ons, pull-offs, slides, bends and pre-bends, vibrato, harmonics, taps, repeats (including `x3`), picking, fingering and palm-mute marks, joins across bar lines; a **Symbols** reference. Released.
  - Editing: click a note and press a key for its length; arrow keys move between notes and bars. Released.
  - **Click a bar number** to loop that bar (Shift-click for a range); **Ear** hides the tab while it plays. Released.
  - **Staff** shows real notation under the tab. Released.
  - **Trainer:** listens through Live input and marks each note right or wrong, with a running score; bends and pre-bends handled. Released.
  - **Bar-accuracy colours:** each bar number is coloured by how well that bar was last played (green clean to red missed), with the count on hover, saved per song, and **Clear bar colours**. Released in 0.9.3.
- **Drum notation:** the Drums part takes a drum grid (one row per kit piece such as `HH`, `SD`, `BD`, `CC`; one column per sixteenth; `x` hit, `X` accent, `o` open hi-hat, `g` ghost) and draws it as a percussion staff (hands up, kick down, x heads for hi-hat and cymbals, rests, beams, bar numbers, repeats); follows along like a guitar tab with taps, bar loops, repeats and Ear; has its own Symbols legend. Released in 0.9.4.
- **Lyrics:** plain, or synced (LRC) with Follow along, click a line to jump, a timing nudge, and Import .lrc. Released.
- **Chords over the lyrics:** with synced lyrics in Follow along, a **Chords** button writes each chord above the word where it changes, like a chord sheet; the chord sounding now is lit. It uses the same names as the timeline (Simple, pitch shift, capo) and redraws when you correct a chord. Chords are placed by their time within each line (lyrics are timed by line, not by word), so they are close, not exact. Released in 0.9.4.
- **Float** the Scratchpad as a movable, resizable window. Released.

## Native audio engine [desktop] (experimental)
- **Direct sound-card playback** of songs saved in the library through a Rust engine with a buffer size you choose: mixer, EQ, tempo and pitch, loops, count-in, click and the speed trainer. Released in 0.9.2.
- **Native live input and recording** in the same engine, so a take lines up with the song to about a millisecond with no manual alignment; native monitor, level, tuner and trainer; its own latency value, set by Measure or the Loopback test. Released in 0.9.2.
- **Native audio panel:** devices with plain-words routing and a recommended choice, buffer size and sample rate, a quick native monitor, and a loopback round-trip test. Released.
- **Safety:** a lost audio device falls back to the normal engine from the same spot; load and dropout counters; clear advice for device errors. Released.
- **Playhead follows the sound** at slow tempos or with a pitch shift (corrected for the time-stretch delay). Released in 0.9.3.
- Builds and passes tests on Linux, Windows and macOS; only Linux has been used with real audio.

## The app itself
- **Desktop app** for Windows (`.exe`, `.msi`), macOS (`.dmg`) and Linux (`.deb`, `.rpm`, AppImage), built by CI; the web app installs on desktop and phone. Released.
- **About:** version, what uses the network, credits and licences, a Support link, **Check for updates** [desktop], and **Copy diagnostic info** for bug reports. Released.
- **Support:** a PayPal link in About and the README, and a Sponsor button on the repository. Released.
- **Appearance:** dark theme by default, a light theme, remembered. No flash of the wrong theme at start, and the desktop window starts dark. Released in 0.9.4.
- **No stray text selection** and no ghost image when dragging controls or resizing a track. Released in 0.9.4.
- **Export:** single stems, all stems (folder or ZIP), or "what you hear" as a mix with your levels, loop, tempo and pitch applied. Released.

## Safety and help (0.9.4)
- **Before separating a very long file** (about 15 minutes or more, or more than the machine's memory allows) a heads-up with what to try if it stalls.
- **Disk-space check** before saving a song to the library, and a "last backed up" line (with a nudge after a month) under the Library.
- **Older saved songs** are brought up to date by one tested function, so an update never loses a scratchpad.
- **Unsaved songs** tell you they use the normal engine when native audio is on.
- **Reset app preferences** (Settings): puts the theme, panels, live-input and native-audio choices back to how they start, without touching songs, setlists or separation settings.
- **Accessibility:** a visible keyboard focus ring on every control; bar-accuracy colours also shown by an outline.
- **Documents:** `FAQ.md`, `PRIVACY.md`, `LICENCES.md` (dependency licences), bug-report and suggestion forms on GitHub.

## Known limits
See "Honest limitations" in `README.md` and "Known limits" at the end of `TEST_CHECKLIST.md`. In short: chord detection is a first draft (about 60–75% right); the playing Trainer is for pitched parts only; drum grids finer than sixteenths are rounded; native audio needs a saved song and shared sample rates.
