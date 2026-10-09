# Steminize: full test checklist (every feature, old and new)

Tick each line as you go and note anything odd. Send me the failures (the section number and what happened) and I'll fix them.

**How to test.** Use the real desktop app, not just a browser tab, because several things only go wrong there (WebKitGTK on Linux, the sound card, the file system).
- From source: `git checkout native-audio && npm run tauri dev`.
- Or install a release: `.deb` / `.rpm` / AppImage (Linux), `.exe` / `.msi` (Windows), `.dmg` (macOS).
- Sections marked **[web]** also apply to the browser/PWA version; sections marked **[desktop]** are desktop only.
- You will want: one song you know well (MP3 or WAV), a few short audio files for the multitrack test, a guitar or bass and an audio interface (or a mic), headphones, and a spare cable to patch an interface output to an input.

## 0. Test material

**All-features tab.** Paste into Scratchpad → Tab:

```
4/4
e|-5h7--7p5--5h7p5-|-----------------|-----------------|-----------------|-7v--x--T12--7~--|-12(h)--7(ph)--5-|
B|-----------------|-5/7--9\7--5/12--|-----------------|-----------------|-----------------|-----------------|
G|-----------------|-----------------|-7b9--7b9r7--5b6-|-----------------|-----------------|-----x---x-------|
D|-----------------|-----------------|-----------------|-7pb9--7pb9r7----|-----------------|-----------------|
A|-----------------|-----------------|-----------------|-----------------|-----------------|-----------------|
E|-----------------|-----------------|-----------------|-----------------|-----------------|-----------------|

   D   U   D         D    U  D             D U D U D     D               
                                           PM--------                    
e|*----12--5~------|-----------------|-----------------|-12(h)----------*|
B|*----------------|-7---T5--7~------|-----------------|----------------*|
G|*9---------------|-----------------|-----5-7-5-7-5b6-|----------------*|
D|*9---------------|-----------------|-----------------|----------------*|
A|*7---------------|-----------------|-----------------|----------------*|
E|*----------------|-----------------|-----------------|----------------*|
   1   4   1         1    2  1              1 2 3 4 1                    
                                                         [1]             
   q   q   h         q.   e  h         Q   e       q     w               
```

**Simple tab for timing and the trainer** (open low E, four times a bar):

```
e|-----------------|
B|-----------------|
G|-----------------|
D|-----------------|
A|-----------------|
E|-0---0---0---0---|
```

## 1. Install, launch and About

- [ ] The installer for your platform installs and the app opens (note the OS and version).
- [ ] Linux AppImage: opens, and a saved song opens and plays (it used to sit on "Opening…").
- [ ] The version number in the header matches the release (0.9.3).
- [ ] **ⓘ About** shows the version, what uses the network, credits and licences, and a Support link that opens in your browser.
- [ ] **Check for updates** (desktop) says whether a newer version exists; for 0.x it should only mention newer 0.x pre-releases.
- [ ] **Copy diagnostic info** copies a plain-text summary (try pasting it); it holds no song names or personal details.
- [ ] The **?** help button opens something sensible.
- [ ] Dark / light theme toggle (moon button) changes the whole app and is remembered after a restart.
- [ ] Models and Settings buttons open; nothing is cut off when the window is narrow or wide (down to about 800 px wide).

## 2. Importing and separating songs [web]

- [ ] Drag an MP3 onto the drop area: it queues, shows progress and time left, and finishes with a song in the player.
- [ ] Click the drop area and choose files (MP3, WAV, FLAC, M4A, OGG each opens).
- [ ] Drop several songs at once: they queue and run one after another; one failing doesn't stop the rest.
- [ ] **Settings tab:** change model (HT Demucs / Fine-tuned / 6-stem), precision (fp16 / fp32), device (auto / GPU / CPU), two-stem mode, shifts, overlap, clip mode, output format (WAV 16/24/32f, FLAC 16/24, MP3 bitrates). The "New songs use …" line under the drop area updates.
- [ ] First run of a model downloads it with a progress indication; after that it works offline.
- [ ] The header shows what is being used (CPU threads or GPU) and that it is on-device.
- [ ] Two-stem (karaoke) mode gives vocals + "everything else".
- [ ] **Open multitrack…**: choose several audio files: each becomes a lane, no separation, all the player tools work.
- [ ] **Open folder…** [desktop or Chromium]: a whole folder opens as lanes.
- [ ] **From YouTube…** [desktop]: search, pick a result, it downloads into the queue (first use fetches yt-dlp). Cancel and error cases are handled.
- [ ] A song that is too short, silent, or an unsupported file gives a clear message, not a hang.

## 3. Library and backup [web, desktop]

- [ ] A separated song appears under **Library** with its length, tracks, BPM, size and date; clicking it reopens instantly.
- [ ] **Keep new songs** off: a new song plays but isn't saved; on: it is saved.
- [ ] Rename a song (click its title); the library entry updates.
- [ ] Delete a song (×) asks first; it disappears and its files are removed.
- [ ] Mixer, EQ, loop, practice settings, markers, tempo, pitch and scratchpad are restored when you reopen a song.
- [ ] **Back up…** saves one zip; **Restore…** brings songs back and skips ones you already have.
- [ ] Practice time per song is counted (the "practiced" line grows while a song plays, not while paused).

## 4. Setlist [web, desktop]

- [ ] **New**, **Rename**, **Delete** a setlist; add songs from the dropdown; reorder; remove.
- [ ] **Play setlist** starts the first song; **Prev / Next** step through.
- [ ] **Auto-advance** with a gap (none, 2, 5, 10 s) shows a countdown and starts the next song by itself.
- [ ] Each entry shows key, BPM, speed and whether a section is looping.
- [ ] The dropdowns are themed (not plain white) and readable in both themes.

## 5. The player: transport, loop, markers, zoom

- [ ] Play / pause (button and Space), restart (|◀), skip (▶|), ±5 s (arrows or the ⏪ ⏩ buttons).
- [ ] Click the overview waveform to seek; drag to scrub (audio follows while scrubbing, silent when stopped drag ends).
- [ ] No ghost image follows the pointer when dragging a waveform or when resizing a track's height (the handle between tracks).
- [ ] You cannot select text by dragging over the interface (inputs, notes and the diagnostics box can still be selected).
- [ ] **Loop:** Shift-drag across the overview or any track to set a section (cyan); **Set A / Set B**; drag the A or B edge; **Clear** removes it; the Loop button turns it on and off.
- [ ] **Snap** (Off / Beat / Bar) snaps loop edges and markers to the beat grid.
- [ ] **+ Marker** adds a named marker; click to jump, rename, ⟳ loops that section, delete; markers are saved per song.
- [ ] **Zoom:** −, +, Fit, mouse-wheel on a picked track (only that track zooms), keys + − 0; the scroll bar pans when zoomed; beat lines show when zoomed in.
- [ ] Teal **beat lines** show on every track once zoomed in far enough (bars stronger), only after tempo analysis has finished.
- [ ] Resize a track's height by dragging the handle; double-click resets; Shift with + / − resizes all.
- [ ] **Volume** (master) works; **Pan** shows the per-track pan sliders.

## 6. Mixer and EQ

- [ ] **M** mute and **S** solo per track (and keys 1–6 for the first tracks); solo logic is sensible (several solos add up).
- [ ] Level slider per track; pan slider (double-click centres) with the CTR / L / R readout.
- [ ] **EQ** panel opens: presets (Kick, Snare, Hi-hats, Bass on small speakers, Vocal clarity), low-cut, high-cut and focus band (frequency, gain, Q) change the sound; the response curve is drawn; flat means off.
- [ ] Undo / redo of mixer changes (if you use the shortcuts) behaves.
- [ ] Download button on a track exports that stem.

## 7. Tempo, pitch and practice tools

- [ ] **Tempo** 50–150% changes speed without changing pitch; **Reset** returns to 100%. **Pitch** ±12 semitones changes pitch without changing speed.
- [ ] **Tempo & key** drawer: BPM and bar detection show; **½× / 2× / tap** corrects a wrong tempo and the beat lines follow.
- [ ] Key detection shows; with a pitch shift the shifted key is shown; clicking the key shows other likely keys; check the loop or a section only; set it by hand.
- [ ] **Practice** drawer: **Count-in** adds a bar of clicks before play and before each loop pass; **Click** plays a metronome in step with slowed audio; click volume works; gap between passes (none / 2 / 5 / 10 s).
- [ ] **Speed trainer:** start 70%, +5%, every 1 pass, to 100% on a loop; it steps up each pass and stops at the target.

## 8. Chords, notes, freeze, MIDI

- [ ] **Notes** view: rows per semitone, for all parts or a single stem; the keyboard beside it lights up with what is playing; clicking a key plays that pitch; hovering shows the name; the preview timbre differs for bass / guitar / vocals.
- [ ] **Freeze** (F) holds the sound at the playhead as a steady tone; clicking elsewhere moves it.
- [ ] **Chords** detected along the bar grid; click a chord to correct it (suggestions, root/type, slash bass, split); corrections are marked and kept after reopening; **Chart ⤓** saves a text chart using your markers as sections, transposed if pitch is shifted.
- [ ] **To MIDI** for a stem and for all parts; **MIDI ⤓** saves one MIDI file at the song's tempo.

## 9. Tuner

- [ ] **Tuner** drawer: with Live input monitoring, play a single open string: note, Hz and a needle showing cents sharp or flat.
- [ ] Choose a stem as the source instead: it tunes against the track; with a pitch shift applied it reads correctly.
- [ ] Silence and chords are ignored rather than guessed at.

## 10. Scratchpad: lyrics, drum tab, notes

- [ ] The five tabs (Lyrics, Guitar, Bass, Drums, Notes) keep separate text per song and survive a restart.
- [ ] **NEW: parts.** Guitar and Bass each keep their own tab text, taps, Follow along / Staff / Trainer / Ear and bar colours: type a tab in Guitar, switch to Bass (it starts with a blank four-string template), switch back and nothing has changed or leaked across.
- [ ] A song saved before parts existed opens with its tab on Guitar (a four-string tab opens on Bass instead).
- [ ] **Track link:** on opening a part, a **Track** dropdown shows the track it is linked to: with a 4-stem split, Bass is linked to "bass", Drums to "drums" and Guitar to "other"; with a 6-stem split Guitar is linked to "guitar"; with a multitrack, parts match by file name ("Lead Guitar", "Bass DI", "Drums"); no match shows "(none)". Choose a different track from the dropdown and it sticks after a restart.
- [ ] The linked track is outlined with a dashed line in the track list while its part is open, and the outline goes when you go to Lyrics or Notes.
- [ ] A track that has a linked part shows a small **Tab** button; pressing it opens the Scratchpad on that part.
- [ ] **Play without …** mutes the linked track and the button stays lit; unmuting the track from its own M button un-lights it.
- [ ] Double-click Guitar / Bass / Drums to rename it (Enter keeps, Escape cancels, empty goes back to the default); the "Play without …" label and the track's Tab tooltip use the new name; it sticks after a restart.
- [ ] The drawer summary lists the parts that have something in them.
- [ ] **Float** pops the Scratchpad out as a floating window: it can be dragged, resized and docked again; its position is remembered.
- [ ] **Lyrics:** paste plain lyrics; paste LRC (`[mm:ss.xx] words`) or **Import .lrc…**: **Follow along** highlights the line being sung, dims sung ones, and clicking a line jumps the song there; **− / +** nudge by 0.2 s; **Search lyrics ↗** opens a search.
- [ ] The **Drums** tab keeps ASCII aligned; **Extend line** adds bars.
- [ ] Typing in a Scratchpad box never triggers the player's shortcuts (e.g. typing "1" or "-" doesn't mute or zoom).

## 11. Tab+ (Scratchpad → Tab)

### 11.1 Timing and Follow along
- [ ] Type a tab, put the cursor on the first note, click **Tap ⏱** (or Ctrl/⌘+Enter): "1 tap set" appears and **Follow along** shows.
- [ ] Follow along shows engraved tab (fret numbers and a rhythm row underneath).
- [ ] Press play: the view slides, the position marker stays about 40% across, the sounding note is boxed.
- [ ] One tap is enough: timing follows the song's detected tempo. Change the tempo in Tempo & key and the follow speed changes.
- [ ] A second tap later interpolates between taps; **Clear timing** removes them.
- [ ] Tap tags (green T) on the overview: drag, lock/unlock, remove, click to jump.
- [ ] The marker (position line) is thick, translucent and centred on the fret number and its stem.
- [ ] Blank space before bar 1 shows the shortcut reminder and scrolls away.
- [ ] Bar numbers show above every bar (also on the Staff view).

### 11.2 Rhythm, bars and time signature
- [ ] **Add rhythm line** inserts a line under the strings; letters w h q e s give lengths, `.` dotted, capital a rest, no letter repeats the last.
- [ ] Rhythm stems line up under their fret numbers: single and double-digit frets, beamed eighths, an all-beamed bar, after a dotted note, a rest in the middle.
- [ ] A whole note shows a visible notehead.
- [ ] `4/4` on its own line fixes each bar's length; try `3/4`, `6/8`. A rhythm line overrides it.
- [ ] **Extend line** adds bars without breaking a time-signature line or mark lines.

### 11.3 Editing in Follow along
- [ ] Click a note: an orange outline; click blank space deselects.
- [ ] With a note selected press w/h/q/e/s: its length changes and the ASCII text updates.
- [ ] Left/Right: previous/next note; Shift+Left/Right: previous/next bar; stops at the ends; with nothing selected Left/Right skip ±5 s.
- [ ] Keyboard navigation scrolls the view only when the selection goes off-screen.
- [ ] Click-and-drag on blank space scrolls the tab sideways (only while stopped); pressing play snaps back.
- [ ] Normal arrow cursor normally, closed hand only while dragging; no blue text selection.

### 11.4 Notation symbols (use the all-features tab)
- [ ] `5h7` hammer-on, `7p5` pull-off, chain `5h7p5`.
- [ ] `5/7` slide up, `9\7` slide down, `5/12` wide slide.
- [ ] `7b9` bend (Full), `5b6` (1/2), `7b9r7` bend and release, `7pb9` pre-bend, `7pb9r7` pre-bend and release.
- [ ] `7~` and `7v` vibrato.
- [ ] `x` muted note: clearly visible X centred on its string (also inside a chord).
- [ ] `T12` / `t12` tap; `12(h)` natural harmonic and `7(ph)` pinch harmonic with their labels.
- [ ] Labels (Full, P.M., finger numbers) look the same weight as the other labels.
- [ ] Lines above/below the strings: `D` / `U` picks, `1`–`4` left-hand and `[1]`–`[4]` right-hand fingers; marks one column off still land on the nearest note; two stacked rows don't overlap strings or the rhythm row.
- [ ] `PM------` palm mute: "P.M." and a dashed line; two runs on one line stay separate; a run above and below at once; a run across a bar line is labelled once.
- [ ] `|*` … `*|` repeat barlines; `x3` shows "×3".
- [ ] Joins across a bar line: `5h|7`, `7p|5`, `5/|7`, `9\|7`.
- [ ] **Symbols** toggles the reference panel; it matches what actually works.

### 11.5 Repeats, bar loops and ear training
- [ ] Playing across a repeat jumps back and plays it twice (three times with `x3`), then carries on.
- [ ] Click a **bar number**: that bar loops (the loop info shows its time range). Shift-click another bar loops the range.
- [ ] Bar-number click with no taps set shows a "Tap the tab first" message.
- [ ] **Ear**: while playing the tab is hidden (message shown, cursor and box stay); on pause it returns; survives reload.

### 11.6 Playing trainer (needs Live input monitoring)
- [ ] **Trainer** (turns Follow along on): right note turns the box green, wrong red; running "hits/total · %".
- [ ] A chord counts as a hit if one of its notes matches. Muted notes and rests are not judged.
- [ ] Bend: either the starting or the bent-to pitch counts; pre-bend: only the bent-to pitch.
- [ ] A repeat jumping back does not reset the tally; scrubbing back or a loop restart does.
- [ ] **NEW: bar-accuracy colours.** Loop bars 1–4 and play them with some mistakes: each bar number gets a colour behind it (green for a clean bar, amber for part right, red for all missed) as you pass through it.
- [ ] Hover a bar number: the tooltip says "Last time: n of m notes (x%)".
- [ ] Play a bar cleanly the next time round: its colour moves to green (it shows the latest attempt).
- [ ] The colours stay when you pause, and after you close and reopen the song.
- [ ] **Clear bar colours** (only shows when there are colours) removes them all.
- [ ] Bars you haven't played yet stay uncoloured.

### 11.7 Speed trainer gated on accuracy
- [ ] Practice → Speed trainer: start 70%, +5%, every 1 pass; loop a section (try clicking a bar number).
- [ ] Tick **only when the tab Trainer scores ≥ 90%**.
- [ ] Without Trainer / Live input on: the info line says to turn them on; the speed never ramps.
- [ ] A clean pass: "last pass 100% — good, speeding up"; speed steps up; stops at the target.
- [ ] A poor pass: "need 90%, holding speed"; never slows down by itself.
- [ ] "Passes per step" above 1 needs that many clean passes in a row; one bad pass resets the run.
- [ ] Unticking the gate gives the plain ramp again.

### 11.8 Staff view and saving
- [ ] **Staff** shows real notation under the tab, follows the music, the cursor line lines up with the tab's.
- [ ] Tab text, taps and the Follow / Staff / Trainer / Ear toggles are saved per song: close and reopen, restart the app; each song keeps its own tab.

## 12. Live input and recording (normal / web engine)

Turn **Use native playback** off for this section.
- [ ] **Monitor** starts; the device dropdown lists your interface; you hear yourself; the meter moves.
- [ ] **Level** and **Pan** change what you hear (pan shows CTR / L / R).
- [ ] The **channel** choice (Stereo / Input 1 / Input 2 / Inputs 1+2 summed): with a guitar in input 1, Input 1 is louder than Stereo.
- [ ] The Level slider goes up to 4 and a quiet input can be boosted.
- [ ] **Level 0** with your interface's direct monitor: you still record and the meter / tuner / trainer still work.
- [ ] **Low-latency audio** ticked: after a restart the delay is smaller (Native audio row not needed).
- [ ] **Record** on a new track: Get ready… lead-in, recording, **Stop**: a take appears; **Keep last** limits the number; switch between takes; delete one; add a note to a take.
- [ ] While recording, the playhead cannot be moved and a loop is paused; tempo returns to 100% for the take and is restored afterwards.
- [ ] **Punch in on loop** records only across A–B, then stops and pauses.
- [ ] Record into an existing track (the "record onto" dropdown).
- [ ] **Latency:** **Measure** (output patched to an input, or speakers near a mic) fills the box; a number can be typed; takes are shifted earlier.
- [ ] **Line up** under a take: « 10 / ‹ 1 / 1 › / 10 » slide the take; the readout shows the shift; **Use as latency** stores it and later takes land where this one sits.
- [ ] Takes are saved with the song and are still there after a restart.
- [ ] The record controls sit on one row; the Latency box shows ms.

## 13. Native audio engine [desktop, experimental]

### 13.1 The panel
- [ ] Live input drawer → **Native audio (experimental)** row shows (desktop only; not in a browser).
- [ ] The output and input dropdowns are themed and compact; the recommended device (`pipewire` on a PipeWire system, `pulse` on PulseAudio) is preselected and marked.
- [ ] A line under the row says where each choice goes (for example "pipewire → PipeWire directly"; `default` says what your system makes it).
- [ ] ALSA plug-in entries (lavrate, samplerate, upmix …) are not in the list.
- [ ] Buffer sizes 32–1024 frames and Auto / 44100 / 48000 / 96000 Hz are selectable; **Refresh** re-lists devices.
- [ ] **Native monitor** (the quick test): you hear your input with low delay; stats show the queue and dropouts; **Loopback test** reports a round trip in ms (with an output patched to an input).
- [ ] Your last choices are remembered after a restart (and native playback comes back on if it was on).

### 13.2 Native playback
- [ ] Tick **Use native playback**, then reopen a saved song: it plays.
- [ ] Play, pause, seek (click the overview), scrub, restart.
- [ ] Loop a section; loop passes repeat cleanly with no click at the loop point.
- [ ] Tempo (50–150%) and pitch (±12): sound is clean; compare the sound with the normal engine (it uses a different stretcher).
- [ ] Mixer: mute, solo, level, pan, EQ all change the sound; the master Volume works.
- [ ] Count-in and Click play and stay in time with the music, also at slow tempo.
- [ ] Speed trainer and gap between passes work.
- [ ] The playhead and waveform stay in step with what you hear, including at slow tempos (it used to run about 60 ms ahead of the sound when slowed).
- [ ] "Audio load" and "dropouts" show under the row and stay near 0 at 128 frames; try 64 and 256 and note when it crackles.
- [ ] A song that is not saved in the library still plays (in the normal engine).
- [ ] Switching the tick off and reopening the song returns to the normal engine.
- [ ] Tab follow-along, the tab trainer, bar colours and the tuner behave the same as before while playing natively.

### 13.3 Native live input and recording
- [ ] With a native song open, **Monitor**: you hear yourself with low delay; the meter moves; the Level / Pan sliders work; the device and channel come from the Native audio row (the old pickers are hidden).
- [ ] The tuner and the tab trainer read the native input.
- [ ] **Measure** in the Live input drawer (output patched to an input) fills the Latency box with a small number (a few ms).
- [ ] **Record**: a take lands in time with the song with **no** manual alignment (check against the beat lines).
- [ ] Record on a second track and on an existing track; takes are saved and reload after a restart.
- [ ] **Line up** and **Use as latency** work on a native take and adjust the native value (not the web one).
- [ ] Punch-in on a loop works.
- [ ] Level 0 still records.
- [ ] Unplug the interface (or stop the sound server) while a song plays: the app says the device was lost, switches back to the normal engine and carries on from the same place; a take in progress is reported as lost.

### 13.4 Platforms
- [ ] **Linux** installers (deb, rpm, AppImage): the Native audio row lists devices and plays.
- [ ] **Windows** and **macOS**: note whether devices are listed, whether native playback and recording work, and what the delay feels like (not yet tried by the maintainer).

## 14. Export

- [ ] **Save all stems**: to a folder (desktop) and as a ZIP; file names and formats match the settings.
- [ ] **Export mix**: "what you hear" with your levels, loop, tempo and pitch applied.
- [ ] A single track's download button exports one stem; MP3 / FLAC / WAV depths all open in another player.

## 15. Hands-free and keyboard

- [ ] **PageDown** plays/pauses and **PageUp** restarts the section; "Foot pedal mode" (Settings) maps arrow-key pedals the same way.
- [ ] Media keys / system media controls play, pause, restart, skip and seek, and the screen stays awake while a song plays (where the system supports it).
- [ ] Space, arrows, F (freeze), + − 0 (zoom), 1–6 (mute) work, and none of them fire while you type in a text box.

## 16. Appearance and robustness

- [ ] Dark theme: fret digits are readable in the engraved tab; the Scratchpad content is always light; the toolbar follows the theme.
- [ ] Resize the window narrow and wide: the Symbols panel, toolbar rows, drawers and Native audio row stay usable.
- [ ] Nothing blocks normal use with a tab open: waveform scrub, loop, mixer, Space.
- [ ] Closing and reopening the app keeps the library, the last settings and per-song state.
- [ ] Opening a corrupt or empty file gives a message, not a frozen screen.

## 17. Web app [web only]

- [ ] The site loads, the model downloads, a song separates, the library saves (browser storage).
- [ ] "Install app" / Add to Home Screen works on desktop and phone.
- [ ] Works offline after the first model download.
- [ ] WebGPU is used where available; otherwise multi-threaded CPU.
- [ ] No Native audio row is shown in a browser.

## 18. Releases

- [ ] Each installer in the release list opens and runs.
- [ ] The release is marked pre-release; the update check offers 0.x installs only newer 0.x pre-releases.
- [ ] Uninstall works and leaves your library alone (library lives in the app's data folder).

## Known limits (not bugs)

- Repeats: no nested repeats, no first/second endings.
- Joins across a *system* break (a new block of lines) aren't drawn.
- Bends / pre-bends affect the trainer only; playback audio is the song, not a synth.
- Techniques, mark lines and bar colours aren't drawn on the Staff view.
- Dotted lengths can't be set by key in Follow along (type them in the rhythm line).
- Bar colours are red / green only; the exact count is in the tooltip.
- Native audio: saved songs only; needs the input and output to share a sample rate; takes are mono at 44.1 kHz; Windows / macOS and JACK / ASIO are not tested or not built yet.
- The native engine's time-stretch is a different algorithm from the normal engine's, so slowed audio sounds a little different.
