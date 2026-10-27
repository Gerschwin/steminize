# Steminize: features

Everything the app does as of 2026-10-25 (version 0.9.6). **Released** means it is in v0.9.3 or earlier; **Released in 0.9.4**, **0.9.5** or **0.9.6** means it is new in that pre-release. Ideas that are not built are in `BACKLOG.md`; what 1.0 needs is in `V1_CRITERIA.md`.

Where it works: the desktop app (Windows, macOS, Linux) and the web app (installable on desktop and phone) are the same code. A few features
are desktop only and are marked **[desktop]**.

## Getting audio in
- **Split songs into stems** with Meta's Demucs v4: HT Demucs (fast), HT Demucs Fine-tuned (best, about 4 times slower) and HT Demucs 6-stem (adds guitar and piano; the default). Each comes as a compact (fp16) or full (fp32) download. Released.
- **Demucs options:** two-stem (karaoke) mode, shifts, overlap, clip mode; output as WAV (16, 24 or 32-bit float), FLAC (16 or 24) or MP3 (128–320 kbps). Released.
- **Batch queue:** drop in several songs; each shows progress and time left. Released.
- **Open multitrack:** open separate track files or a whole folder and each becomes a lane, with all the same tools (a shared folder makes this a simple way for a band to share parts). Released.
- **From YouTube [desktop], opt-in:** search and download audio into the queue (fetches yt-dlp on first use). Off until you turn it on under Settings → From YouTube, after a notice about only downloading audio you own, that is royalty-free or Creative Commons, or that you have the right to use. The opt-in is new in 0.9.4; the feature itself was released earlier. The Windows black command window no longer appears: released in 0.9.3.
- **Model downloads carry on where they stopped:** a lost connection or a Stop keeps what arrived; the next try asks only for the rest. Models shows how much is kept, with Resume and Discard. Released in 0.9.5.
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
- **Tighter layout (after 0.9.6):** less padding and gaps throughout, the drag handle under each track no longer takes a row, the title and details share a line, and the **Songs / Settings panel narrows to a rail while a song is open** (click a tab on the rail to open it over the song, click elsewhere or press Escape to put it away; the » button keeps it open, remembered). The input device, channel, latency tools and the whole Native audio block moved from the Live input drawer to **Settings, Audio input & latency**; the drawer keeps Monitor, level, pan, Record and a one-line summary ("Native · JACK · 64 frames · capture_AUX1 · load 3%") with an **Input settings…** link.
- **Record button in the transport bar** beside Play (greyed until the monitor is on), with the elapsed time next to it, and **R** starts or stops a take (the button keeps one width as it changes between Rec and Stop); with a beat grid the take starts on a bar line and the Record button counts the song's real beats down to it ("● 4…", "● 3…"; without a grid, a short fixed count), and pressing it again cancels; stopping a take stops the song at that moment, before the take is saved; **Stop playback after a take** (on by default, in the Live input drawer) stops the song when a take ends, untick it to let the song play on; the track picker, Punch in and Keep-last stay in the Live input drawer. Added after 0.9.6.
- **Record** a take onto a new or existing track, with a lead-in; **Keep last** takes per track, switch between them, add notes, delete; saved with the song. Released. The take being played can be deleted too (× on its row); when it is the only take, **× Delete track** removes the whole recorded track. Deleting happens at once with an **Undo** for ten seconds (no "are you sure" box); the audio file is only removed from the library when the time is up or another song is opened, so closing the app in that window loses nothing. Added after 0.9.6.
- **Punch in on loop:** record only across the marked section. Released.
- **Latency tools:** Measure (output patched to an input, or speakers near a mic), a typed value, and **Line up** (nudge a take against the beat lines, then Use as latency). **Low-latency audio** option. Released in 0.9.2.

## Learn (practice method)
- **Learn drawer:** work through a song the way the practice method says to: **sections** (your markers) become checkpoints, each section is split into **chunks** of 1, 2 or 4 bars (or the whole section) that start on bar lines, and you loop one chunk at a time. **Loop this chunk** starts it; the **◀ ▶** buttons (or `,` and `.`) move along; **Stitch next chunk** joins pieces back together. Every loop pass is counted, and a **clean-pass streak** (default 20 in a row) finishes the chunk: press **Nailed it** (`N`) or **Missed** (`X`), or let the **tab Trainer** judge each pass (it counts as clean when the accuracy is high enough). At the target it ticks the chunk off and moves on to the next one (and on to the next section). A checklist shows each section as New, Learning or Solid with progress; mark one solid by hand or reset it. Progress is saved with the song. Released in 0.9.6.
- **Suggest sections** (draft): the **Suggest sections** button listens to the song and finds where the intro, verses, chorus, bridge and outro start, by comparing every bar with every other (repeats show up as stripes) and finding where the music changes. It offers them as editable section names with times; **Add as markers** keeps your own markers, **Replace my markers** swaps them. Needs a detected tempo. It is exact on clearly built test songs and gave a plausible result on a real rock song, but the names are guesses and quiet or unusual structures can be missed or split oddly: change anything you like.
- **Not built yet:** spotting where a riff repeats.

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
- **Full window** (`T`, or the button next to Float): the Scratchpad fills the whole window with the notation drawn larger (**A−** / **A+**, or `-` / `+`; remembered), and a play bar along the bottom (back, skip, play, loop, tempo, **Edit tab** which is Follow along turned off). `Esc` or **Close** goes back to where the Scratchpad was. One part at a time (Guitar, Bass, Drums), with the Staff under it if it is on (scroll down to it). Not yet released.

## Steminize Player plugin (early, in development)
- **A VST3 plugin** (`plugin/`, GPLv3) that plays a song's stems inside a DAW in time with its transport: a mix output plus eight stem outputs, per-stem level / mute / solo, a master level and an offset. Songs come from **Send to DAW** (`steminize-song.json`). Checked in Ardour 9.7 (scan and an offline render); follows the DAW's tempo (time-stretch, pitch kept), has a key shift, and has a window to load a song and set each stem. Not in the installers.

## Native audio engine [desktop] (experimental)
- **Off by default, but not hidden:** a tip in the Live input drawer says it exists (with **Show me** and **Got it**), the desktop Settings has a Native audio card with **Show me where**, and the welcome panel mentions it. Released in 0.9.5.
- **Direct sound-card playback** of songs saved in the library through a Rust engine with a buffer size you choose: mixer, EQ, tempo and pitch, loops, count-in, click and the speed trainer. Released in 0.9.2.
- **Native live input and recording** in the same engine, so a take lines up with the song to about a millisecond with no manual alignment; native monitor, level, tuner and trainer; its own latency value, set by Measure or the Loopback test. Released in 0.9.2.
- **JACK as one stream [experimental, desktop]:** a "JACK (one stream)" choice in the Native audio host list runs the song, click, monitor and recording in a single JACK callback, so the monitored instrument goes straight through with no queue between input and output (the ordinary path queues about a block and a half). The buffer size you choose is asked of PipeWire; with jackd it is the server's. Takes are placed using the round trip JACK reports for the connected ports. Linux first (libjack is loaded when needed, so the app still starts without it); not tried on Windows / macOS, and not tried with a real USB interface yet.
- **Native audio panel:** devices with plain-words routing and a recommended choice, buffer size and sample rate, a quick native monitor, and a loopback round-trip test. Released.
- **Safety:** a lost audio device falls back to the normal engine from the same spot; load and dropout counters; clear advice for device errors. Released.
- **Playhead follows the sound** at slow tempos or with a pitch shift (corrected for the time-stretch delay). Released in 0.9.3.
- Builds and passes tests on Linux, Windows and macOS; only Linux has been used with real audio.

## The app itself
- **Desktop app** for Windows (`.exe`, `.msi`), macOS (`.dmg`) and Linux (`.deb`, `.rpm`, AppImage), built by CI; the web app installs on desktop and phone. Released.
- **About:** version, what uses the network, credits and licences, a Support link, **Check for updates** [desktop], and **Copy diagnostic info** for bug reports. Released. **In-app update** [desktop]: where the install can replace itself (Windows, macOS, the Linux AppImage), an **Install and restart** button downloads the update, checks its signature against the key built into the app, installs it and restarts; .deb and .rpm installs get the download link. New in 0.9.5, so 0.9.4 to 0.9.5 is still by hand; it can be tried for real once 0.9.6 is out (see UPDATER.md).
- **Support:** a PayPal link in About and the README, and a Sponsor button on the repository. Released.
- **Appearance:** dark theme by default, a light theme, remembered. No flash of the wrong theme at start, and the desktop window starts dark. Released in 0.9.4.
- **No stray text selection** and no ghost image when dragging controls or resizing a track. Released in 0.9.4.
- **Export:** single stems, all stems (folder or ZIP), or "what you hear" as a mix with your levels, loop, tempo and pitch applied. Released.
- **Send to DAW:** opens the song in a recording program: a ready-made **Reaper** project, **Ardour** session or **DAWproject** file for Bitwig Studio, Studio One and Cubase 14 (stems as tracks with your levels, pan, mute and solo, the song's tempo and bars with the first bar on a bar line, markers and the loop), or for **Logic, Pro Tools, Cubase, Ableton and others** the aligned stems plus a MIDI tempo map and a marker list. See `DAW_EXPORT.md`. Released in 0.9.5.

## Safety and help (0.9.4)
- **Welcome panel** when no song is open: what the app is for, **Choose a song** / **Open tracks I already have** buttons, what the first split downloads (the chosen model's name and size, and whether it is already on this computer), and what you can do with a song. Released in 0.9.5.
- **"Draft" tags** on the Chord timeline and Chords lanes: chord detection is a first attempt, roughly 60 to 75% right. Released in 0.9.5.
- **Before separating a very long file** (about 15 minutes or more, or more than the machine's memory allows) a heads-up with what to try if it stalls.
- **Disk-space check** before saving a song to the library, and a "last backed up" line (with a nudge after a month) under the Library.
- **Older saved songs** are brought up to date by one tested function, so an update never loses a scratchpad; a damaged song file skips that one song instead of stopping the library from listing; and a song folder is never deleted unless its description file is definitely missing and the folder has sat untouched for a day (this fixes a case where an unreadable file could have cost a song its audio). Documented in `DATA_FORMAT.md` and tested against saved songs from every era.
- **Unsaved songs** tell you they use the normal engine when native audio is on.
- **Reset app preferences** (Settings): puts the theme, panels, live-input and native-audio choices back to how they start, without touching songs, setlists or separation settings.
- **Accessibility:** a visible keyboard focus ring on every control; bar-accuracy colours also shown by an outline. New in 0.9.4+ (next release): every control and canvas has a name; library, queue, setlist and lyric rows work with Enter / Space; contrast fixed in both themes (dark text on amber buttons, darker status colours in the light theme); a **Text size** setting in the desktop app (and Ctrl +/−/0) and layout that wraps at large sizes; a Desktop app note in the browser's Settings. Not yet tried with a screen reader.
- **Documents:** `FAQ.md`, `PRIVACY.md`, `LICENCES.md` (dependency licences), bug-report and suggestion forms on GitHub.

## Known limits
See "Honest limitations" in `README.md` and "Known limits" at the end of `TEST_CHECKLIST.md`. In short: chord detection is a first draft (about 60–75% right); the playing Trainer is for pitched parts only; drum grids finer than sixteenths are rounded; native audio needs a saved song and shared sample rates.
