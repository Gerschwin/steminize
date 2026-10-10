# Steminize

A practice studio for musicians. Split any song into stems (vocals, drums, bass, other, and optionally guitar and piano) using Meta's **Demucs v4** model, then practise along: mute or solo parts, loop a section, slow it down or change the key, see the chords and notes, and play your own instrument over the tracks. Learn guitar and bass parts from **tab** that follows the song as engraved notation, with a trainer that listens to you play and a speed trainer that only speeds up when you're getting it right. Everything runs **on your own device**: nothing is uploaded.

It runs as a web app (installable on desktop and phone) and as a desktop app (Windows, macOS, Linux) built from the same code. Currently in pre-release (0.x) ahead of v1.0.

## Features

- **Models:** HT Demucs (fast), HT Demucs Fine-tuned (best, about 4× slower) and HT Demucs 6-stem (adds guitar and piano — the default). Each comes in a compact (fp16) or full (fp32) download.
- **The Demucs command-line options:** two-stem/karaoke mode (`--two-stems`), shifts (`--shifts`), overlap (`--overlap`), clip mode (`--clip-mode`), and output as WAV 16/24/32-bit float, FLAC 16/24 or MP3 128–320 kbps.
- **Batch queue:** drop in several songs; each shows progress and time left.
- **Practice player:** mute, solo, set the level and pan (left–right) of each stem, plus a per-stem EQ with presets (Kick, Snare, Hi-hats, Bass on small speakers, Vocal clarity) and manual low-cut, high-cut and focus band; loop a section (Shift-drag across the overview strip or any track's waveform, or use Set A / Set B; drag the A or B edge to fine-tune it, and **Clear** removes it; the section shows in cyan); change tempo (50–150%) and pitch (±12 semitones) without affecting the other.
- **Open multitrack:** already have separate tracks (a band's parts, DAW exports, rehearsal multitracks)? Open the files or a whole folder and each file becomes a lane: no separation, all the same tools. Tracks line up from their start, so export every part from the same point (e.g. bar 1). With a shared folder (Syncthing, Google Drive for desktop, Dropbox) this doubles as a simple way for a band to share parts.
- **Library:** separated songs are kept on your computer (16-bit FLAC in the browser's private storage) with their mixer, EQ, loop and practice settings, so they reopen instantly. **Back up / restore** the whole library as one zip file, e.g. to move it to another browser or computer; restoring skips songs you already have.
- **Setlist** (the Setlist card under the Library): order songs from your library for a rehearsal or gig. **Play setlist** starts the first song, **Prev / Next** step through, and with **Auto-advance** on the next song starts by itself when one ends, after a gap you choose (none, 2, 5 or 10 s) with a countdown. Each song keeps its own tempo, pitch, loop, mixer and lyrics in the library, so it reopens exactly as you left it, and the list shows each song's key, BPM, speed and whether a section is looping. Setlists live in the browser's settings on the web app, or the app's local settings on desktop, so they are not part of a library backup zip.
- **Practice tools:** tempo (BPM) and bar detection from the drum stem, with ½×/2×/tap correction; loop snapping to beats or bars; speed trainer (e.g. 70% → 100%, +5% per pass); gap between passes; one-bar count-in; metronome click that stays in step with slowed-down audio.
- **Sections, key and zoom:** named section markers (click to jump, ⟳ to loop a section, saved per song); key detection with the shifted key shown when you change pitch (click the key to see other likely keys, check just the loop or a section, or set it yourself); waveform zoom (buttons, scroll wheel or + − 0) with beat lines when zoomed in.
- **Transcription tools** (the **Chords** and **Notes** buttons above the tracks):
  - **Notes view:** which notes are sounding over time, one row per semitone from E1 to C7, for all parts or any one stem, with a keyboard beside it (click a key to hear that pitch, or hover to see its name; it lights up with what's playing). The preview tone's timbre roughly follows whatever part you're viewing (fuller and slower for bass, plucked for guitar, soft for vocals), so it's closer to what you're matching by ear. The keyboard has its own zoom: scroll over it to zoom in on a range of notes, Shift+scroll to pan, double-click to reset. Your computer keyboard also plays it while Notes is open (ZXCVBNM,./ for the white keys, SDGHJL; for the black ones, like a piano). It follows the waveform's zoom, and a pitch shift moves it so it always shows what you hear.
  - **Freeze** (F): holds the sound at the playhead as a steady tone so you can hum it or find it on your instrument. Click elsewhere while frozen to move it.
  - **Timeline:** a scrolling row of beat boxes in time with the music, like a chord-chart player: the chord is written where it starts, the beats it carries on through are dashes, the current beat is lit, bar numbers run along the top. Click a beat to jump to it, click a bar number to loop that bar, **−** / **+** change the width of a beat, and **Simple** shows plain major and minor chords only (no sevenths, sus or slash chords). It follows a pitch shift. A drop-down under the timeline shows **chord diagrams** for the chord now and the next one that differs (with how many beats away it is): guitar and ukulele fingerings (open chords where they exist, barre shapes otherwise) or a two-octave piano keyboard. The diagrams follow the Simple switch and any pitch shift. A **Capo** drop-down (1 to 9) makes the timeline and diagrams show the shapes to play with the capo on that fret (the sound is the same), and **Suggest** picks the capo that puts the most of the song on common open shapes.
  - **Chords:** detected per beat along the bar grid, using the separated bass to find the root. Click a chord to correct it (suggestions, any root/type, slash bass, split in two); corrections are marked and kept. **Chart ⤓** saves a text chord chart in bars, using your markers as sections, transposed if you've shifted the pitch.
  - **To MIDI:** turns a stem (or all parts) into notes with Spotify's Basic Pitch, drawn over the notes view. Lead vocals and bass are kept to one note at a time. **MIDI ⤓** saves every part you've transcribed as one MIDI file, at the song's tempo.
  - How good: the notes view is reliable (it's measurement, not guessing). Chords are a first draft: expect roughly 60–75% right on real songs, better on simple pop/rock with a separated bass, worse on jazz chords, and fix the rest by ear. MIDI is good on bass and single-note melodies, fair on piano, messy on strummed guitar or a full mix.
- **Live input** (in the **Live input** drawer): play a real instrument or mic live alongside the tracks, through whatever's plugged into your computer (built-in mic or a USB audio interface, picked from a device list), with its own level and pan sliders and a small meter so you can see it's actually receiving signal.
  - **Record** captures your playing as a take on a new track, or into one you already recorded. Playback starts if it isn't running, after a short lead-in of about a bar, and the tempo is held at 100% for the take so it stays in step. While a take is recording the playhead can't be moved and a running loop is paused, because either would knock it out of sync with the song. Each track keeps its last few takes (**Keep last**), you can switch between them, and takes are saved with the song in the library.
  - **Punch in on loop** records only across the marked A–B section: playback starts a bar before it, recording runs from A to B, then stops and pauses.
  - **Latency:** there is a delay between what you hear and what gets recorded, so a take lands behind the song by that much (roughly 20–100 ms with a USB interface). Press **Measure** to play a few clicks and listen for them on the input (put the speakers near the mic, or connect an output to the input with a cable; headphones can't work), and takes are shifted earlier by the result. You can also type a value. It starts at 0, which shifts nothing. Browser audio is still not sample-accurate like an ASIO-based DAW, so this is for practising along and rough takes.
- **About** (the ⓘ button in the top bar): the version, what uses the network, credits and licences, and a **Support** link. The desktop app also has **Check for updates** (asks GitHub for the latest release, only when you press it). **Copy diagnostic info** copies a plain-text summary of your setup and recent errors to paste into a bug report; it contains no songs, file names or personal information, and nothing is sent anywhere.
- **Tuner** (in the **Tuner** drawer): a needle tuner for the live input or any stem/track, showing the detected note, Hz and cents sharp/flat. Works best on a single sustained note (a bass or guitar open string, a held vocal note); it ignores silence and chords rather than guessing. Follows any pitch shift you've applied, so it reads correctly against a shifted stem.
- **Scratchpad** (in the **Scratchpad** drawer): plain-text notes per song, in five tabs — Lyrics, Guitar, Bass, Drums and Notes. Each of Guitar, Bass and Drums is linked to the track it is the music for (picked from a **Track** dropdown; it starts on the track with the matching name, and on **Other** for guitar in a 4-stem split, which has no guitar track): that track is outlined in the track list, its **Tab** button jumps back to the tab, and **Play without …** mutes it so you play that part yourself. Double-click a tab to rename it, and press **+** to add more parts (a second guitar, keys, anything), each with its own tab and track link; **Delete part** removes one you added. Every guitar-style tab (Guitar, Bass and the ones you add) keeps its own text, timing, Follow along, Trainer and bar colours. **Drums** is written as a drum grid (one row per kit piece such as `HH`, `SD`, `BD`, `CC`, one column per sixteenth note, `x` a hit, `o` open hi-hat, `X` accent, `g` ghost note) and Follow along draws it as a percussion staff, the way drum sheet music is written, scrolling with the song; tap the first hit to time it, click a bar number to loop that bar, and the **Symbols** button lists the notation. (The playing Trainer and the second Staff are for pitched parts, so they are not offered for drums.) The Tab and Drum tab boxes use a monospace font with no line-wrap, so ASCII tab (`e|--0-1-3--|`) stays aligned as you type or paste it in. Sections already have their own markers (name, jump, loop); this is just free text alongside them. **Synced lyrics:** paste lyrics in the common LRC format (`[mm:ss.xx] words`) or use **Import .lrc…**, and **Follow along** shows the line being sung, dims the ones already sung, and jumps the song to a line when you click it. **−** / **+** nudge the timing in 0.2 s steps for a file made for a different recording. Plain lyrics work as before.
- **Tab+** (Scratchpad → Tab): type or paste ASCII guitar/bass tab, tap it in time with the song, and **Follow along** draws it as engraved notation that scrolls with the music. Supports a rhythm line and time signatures, hammer-ons, pull-offs, slides, bends and pre-bends, vibrato, harmonics, taps, repeats, and picking, fingering and palm-mute marks (the **Symbols** button lists them). Click a note to set its length, click a bar number to loop that bar, and use **Ear** to hide the tab and play from memory. The **Trainer** listens through Live input and marks each note right or wrong, and colours each bar number by how well that bar was last played (green clean, red missed; hover for the count, **Clear bar colours** forgets them); the **speed trainer** can be set to speed up only once you score above a target.
- **Hands-free:** PageDown plays/pauses and PageUp restarts the section, which suits most Bluetooth page-turner pedals; "Foot pedal mode" maps arrow-key pedals the same way. Media keys and lock-screen / notification controls (play, pause, restart, skip, seek) also work where the browser or system supports them, and the screen stays awake while a song plays.
- **Export:** single stems, all stems (to a folder, or as a ZIP), or "what you hear" as a mix with your levels, loop, tempo and pitch applied.
- **Offline:** once a model has downloaded, the app works with no connection.
- **GPU acceleration** through WebGPU where available, otherwise multi-threaded CPU.

## Running it on your computer (development)

You need [Node.js 22 or newer](https://nodejs.org). The repository pins it in `.nvmrc`, so with [nvm](https://github.com/nvm-sh/nvm) just run `nvm use` (an older Node fails with an error about `styleText`).

```bash
npm install
npm run dev
```

Open http://localhost:5173. Other commands:

| Command | What it does |
|---|---|
| `npm test` | Checks the separation maths, the WAV/FLAC/MP3 encoders (needs `ffmpeg` on your PATH for those), latency measurement, take placement and version comparison |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serves the production build at http://localhost:4173 |

## Putting the web app online for free (GitHub Pages)

1. Create a new repository on GitHub and push this folder to it:
   ```bash
   git remote add origin https://github.com/YOUR-NAME/steminize.git
   git push -u origin main
   ```
2. On GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The *Deploy web app* workflow runs on every push. When it finishes, the site is at `https://YOUR-NAME.github.io/steminize/`.

On a phone, open that address and choose **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

## Desktop app (Tauri)

### Easiest: let GitHub build the installers

Push a version tag:

```bash
git tag v0.9.0
git push origin v0.9.0
```

**Versioning:** until the features are complete the app is in pre-release, numbered 0.x (v0.9.0, v0.9.1, …). A tag starting `v0.` is flagged as a **pre-release** on GitHub. v1.0.0 will be the first public release; from then on tags are normal releases. (The app's *Check for updates* offers newer 0.x pre-releases to 0.x installs, and only full releases once it is 1.0 or later.)

The *Desktop builds* workflow builds Windows (`.msi` and `.exe`), macOS (`.dmg`, Intel and Apple Silicon) and Linux (`.deb`, `.rpm`, `.AppImage`) installers. It attaches them to a **draft** release under **Releases**; check it, then click **Publish**.

### Building on your own machine

1. Install Rust: https://rustup.rs
2. Install Tauri's system requirements for your OS: https://v2.tauri.app/start/prerequisites/
   (Windows: Microsoft C++ Build Tools. macOS: Xcode command-line tools. Linux: `libwebkit2gtk-4.1-dev` and friends.)
3. Run:
   ```bash
   npm install
   npm run tauri dev      # run the desktop app in development mode
   npm run tauri build    # build an installer into src-tauri/target/release/bundle/
   ```

### Linux: audio decoding needs GStreamer

The Linux desktop app decodes audio through WebKitGTK, which uses the system's GStreamer install rather than a bundled decoder. If adding a song gets stuck on "Reading audio…" (it times out after 20s with an error instead of hanging forever), install the codec plugins:

```bash
sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

(package names for other distros will differ). This isn't needed for the web app or for Windows/macOS.

### "From YouTube" import

Next to **Open multitrack…** / **Open folder…**, the desktop app has a **From YouTube…** button: enter a song name and artist, pick from the search results, and it downloads the audio straight into the import queue. Desktop-only, because a browser tab has no way to download from YouTube itself; the native side shells out to a standalone [yt-dlp](https://github.com/yt-dlp/yt-dlp) binary, fetched once on first use and cached (no ffmpeg needed — it downloads an audio-only stream directly, no re-encoding or muxing). Everything still runs on your own machine; nothing is uploaded anywhere. You're responsible for having the right to use anything you download, same as with yt-dlp generally.

### Library

The web app and the Windows/macOS desktop apps keep the Library in the browser's private file
storage (OPFS). The Linux desktop app doesn't use that: WebKitGTK (the Linux webview) refuses OPFS's
write API even with every relevant experimental switch turned on ("Backend does not support this
operation"), so on Linux the Library instead stores songs as plain files under the OS's app-data
directory (`~/.local/share/app.steminize.desktop/library/` in a standard install), written through
the native app rather than the webview. Either way it's the same layout, so a backup zip from one
works on the other.

### Microphone (Live input)

On Linux the desktop app allows audio capture for the Live input drawer without a system prompt (camera and other permissions stay denied). On macOS the app declares why it wants the microphone so the system can ask the first time, and on Windows the webview asks for itself (neither of these has been tested by the maintainer yet). If Live input says the request "is not allowed", check the system's microphone privacy settings.

### Getting the lowest delay when playing live

Steminize plays and records through the webview and the system's audio server, so it can't reach the tiny buffers an ASIO/JACK DAW can. These steps get it as low as it goes:

1. **Hear yourself through the interface, not the app.** Switch on your interface's direct/zero-latency monitor and turn the app's **Level** down to 0, so you aren't hearing a delayed copy. Recording, the meter, the tuner and the trainer all listen to the input itself, so they keep working with Level at 0.
2. **Tick Low-latency audio** (Live input) and restart Steminize. It asks for the smallest buffers the webview will give and runs the audio at your sound card's own sample rate (usually 48 kHz) instead of converting.
3. **Shrink the system buffer.** On Linux with PipeWire, `pw-metadata -n settings 0 clock.force-quantum 128` (try 64 if it stays clean; `0` puts it back to automatic) cuts the system's own buffering. On Windows, set the interface's buffer size in its control panel; on macOS, in Audio MIDI Setup or the interface's own app.
4. **Cut other delay sources.** Use wired headphones (Bluetooth adds 100 ms or more), plug the interface straight into the computer rather than through a hub, and close other apps that use audio.
5. **Compensate for what is left.** Press **Measure** (output looped to an input, or speakers near the mic), or record a take against the click and use **Line up** beneath it (zoom in until the teal beat lines, where the click sounds, show on the track, and slide the take until your notes start on them), then **Use as latency**. Takes then land on the beat even though a little delay remains in what you hear.

Expect roughly 20–40 ms at best through the webview. If that is still too much to play against, use the interface's direct monitoring and record in Steminize with the latency compensation above.

### Links

The desktop app opens links (the About dialog, the Models "browse" link, lyrics search, Support) in your default browser. It only opens `https` links to a short list of sites it links to itself.

### Unsigned-app warnings

The installers aren't code-signed, so people will see warnings the first time:

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
- **macOS:** Gatekeeper blocks the app. Right-click it and choose **Open**. If macOS says it's "damaged", run `xattr -cr /Applications/Steminize.app`.

Signing removes these warnings. It costs about £79/year for Apple, and a few pounds a month for Windows via Azure Trusted Signing.

## How it works

```
src/
  engine/separate.ts   Demucs' apply_model in TypeScript: normalisation, shifts, overlapping
                       7.8 s segments blended with a triangular window, bags of specialist models
  engine/worker.ts     ONNX Runtime Web (WebGPU → WASM fallback) in a Web Worker
  models.ts            model catalogue (Hugging Face URLs, sizes)
  modelstore.ts        downloads and caches models in Cache Storage (works offline)
  player/mixcore.ts    stem mixing, looping, SoundTouch time-stretch and pitch-shift
  player/worklet.ts    real-time player (AudioWorklet)
  encode/              WAV, FLAC (own encoder), MP3 (lamejs) and MIDI; runs in a worker
  analysis/            beats and tempo, key, notes view (constant-Q transform), chords,
                       Basic Pitch audio-to-MIDI (model bundled, ~230 KB, own worker)
  ui/                  interface
public/sw.js           offline caching, plus the headers that enable multi-threaded WASM
src-tauri/             desktop wrapper (native save dialogs)
```

The app loads community ONNX exports of the original weights (links in `src/models.ts`). If your network blocks Hugging Face, download the `.onnx` files yourself and use **Models → Import model file…**. The file names must match.

## Browser-compatibility fix for models

Some community ONNX exports use float64 maths in their iSTFT, which the browser version of ONNX Runtime can't run ("Could not find an implementation for ConstantOfShape(9)"). **The app fixes this automatically** when it loads a model. It also turns off ONNX Runtime's graph optimisation, which would otherwise push peak memory for these models from about 1.2 GB to 4.3 GB, past the browser's 4 GB limit (`std::bad_alloc`).

The float64 conversion is done by `src/engine/fixfloat64.ts`, which rewrites those parts to float32 in well under a second.

`tools/fix_models.py` does the same conversion offline and checks the result against the original with onnxruntime. Use it if you want to host pre-converted files on your own Hugging Face repo.

## Honest limitations

- **CPU speed, measured:** with a model of the same architecture, one 7.8 s segment took about 13 s on 2 CPU threads in Chrome. A 4-minute song is about 42 segments, so roughly 9 minutes on 2 threads; expect several minutes on a typical 8-thread laptop, and 4× that for Fine-tuned.
- **Speed is hardware-bound.** WebGPU on a recent GPU is quick. CPU-only (older machines, Linux desktop app, many phones) is much slower, and fine-tuned mode is about 4× slower again. Try one song first.
- **The Linux desktop app runs on CPU only**, because its webview (WebKitGTK) has no WebGPU. It does use all your CPU threads: WebKitGTK hides `SharedArrayBuffer` by default, which silently limits ONNX Runtime to one thread, so the app switches it on. Measured on one 8-thread laptop, the default 6-stem model took about 3× the song's length. On Linux, Chrome or Edge with WebGPU is faster still.
- **Memory:** a 4-minute song needs roughly 1–2 GB of RAM during separation, about 1.2 GB of it for the model and the rest growing with the length of the song (about 3 MB per second of audio with the 6-stem model, so a 25-minute track needs on the order of 5–6 GB in total). Very long files or 6-stem mode on phones can run out. Use the compact model and shorter files there.
- **iPhone/iPad:** works in recent Safari, but iOS may stop the app if you switch away during processing. Keep it in the foreground.
- **Fine-tuned + two-stem mode** runs only the one specialist model it needs and computes "everything else" as *original minus stem*. That's 4× faster, but not bit-identical to the Demucs CLI, which sums the other three stems.
- **Shifts** use random offsets, as in Demucs, so two runs with shifts > 1 differ very slightly.

## More documents
- [FAQ.md](FAQ.md): installing, slow separation, recording delay and other common questions.
- [PRIVACY.md](PRIVACY.md): what stays on your computer and when the app uses the internet.
- [FEATURES.md](FEATURES.md): everything the app does.
- [LICENCES.md](LICENCES.md): every dependency and its licence (regenerate with `node scripts/licence-report.mjs`).
- [TEST_CHECKLIST.md](TEST_CHECKLIST.md) and [V1_CRITERIA.md](V1_CRITERIA.md): testing, and what 1.0 needs.

## Support

Steminize is free and open source, and nothing is held back behind a payment. If it's useful to you, an optional contribution helps keep it maintained: [contribute via PayPal](https://www.paypal.com/ncp/payment/FZTNXUUZ3QWH6).

## Credits and licences

- **Demucs** by Alexandre Défossez, Simon Rouard, Francisco Massa and Meta AI, MIT licence: https://github.com/adefossez/demucs
- **ONNX exports** by StemSplit (`StemSplitio/*` on Hugging Face), MIT licence.
- **ONNX Runtime Web** by Microsoft, MIT licence.
- **SoundTouchJS**, LGPL-2.1. It's used unmodified from npm, and you can swap in your own build of it.
- **lamejs** (MP3), LGPL. **fflate** (ZIP), MIT.
- **Basic Pitch** by Spotify, Apache-2.0: https://github.com/spotify/basic-pitch. The model file is bundled unchanged; its licence and notice are next to it in `src/analysis/models/`. The note-extraction steps are ported from its Python code.
- Steminize itself: MIT (see `LICENSE`).

Only separate audio you have the right to use.
