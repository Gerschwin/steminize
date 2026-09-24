# Stemdeck

Split songs into stems (vocals, drums, bass, other, and optionally guitar and piano) using Meta's **Demucs v4** model. Everything runs **on your own device**: nothing is uploaded.

It runs as a web app (installable on desktop and phone) and as a desktop app (Windows, macOS, Linux) built from the same code.

## Features

- **Models:** HT Demucs (fast), HT Demucs Fine-tuned (best, about 4× slower) and HT Demucs 6-stem (adds guitar and piano). Each comes in a compact (fp16) or full (fp32) download.
- **The Demucs command-line options:** two-stem/karaoke mode (`--two-stems`), shifts (`--shifts`), overlap (`--overlap`), clip mode (`--clip-mode`), and output as WAV 16/24/32-bit float, FLAC 16/24 or MP3 128–320 kbps.
- **Batch queue:** drop in several songs; each shows progress and time left.
- **Practice player:** mute, solo, set the level and pan (left–right) of each stem, plus a per-stem EQ with presets (Kick, Snare, Hi-hats, Bass on small speakers, Vocal clarity) and manual low-cut, high-cut and focus band; loop a section (drag across the waveform); change tempo (50–150%) and pitch (±12 semitones) without affecting the other.
- **Open multitrack:** already have separate tracks (a band's parts, DAW exports, rehearsal multitracks)? Open the files or a whole folder and each file becomes a lane: no separation, all the same tools. Tracks line up from their start, so export every part from the same point (e.g. bar 1). With a shared folder (Syncthing, Google Drive for desktop, Dropbox) this doubles as a simple way for a band to share parts.
- **Library:** separated songs are kept on your computer (16-bit FLAC in the browser's private storage) with their mixer, EQ, loop and practice settings, so they reopen instantly.
- **Practice tools:** tempo (BPM) and bar detection from the drum stem, with ½×/2×/tap correction; loop snapping to beats or bars; speed trainer (e.g. 70% → 100%, +5% per pass); gap between passes; one-bar count-in; metronome click that stays in step with slowed-down audio.
- **Sections, key and zoom:** named section markers (click to jump, ⟳ to loop a section, saved per song); key detection with the shifted key shown when you change pitch (click the key to see other likely keys, check just the loop or a section, or set it yourself); waveform zoom (buttons, scroll wheel or + − 0) with beat lines when zoomed in.
- **Hands-free:** PageDown plays/pauses and PageUp restarts the section, which suits most Bluetooth page-turner pedals; "Foot pedal mode" maps arrow-key pedals the same way.
- **Export:** single stems, all stems (to a folder, or as a ZIP), or "what you hear" as a mix with your levels, loop, tempo and pitch applied.
- **Offline:** once a model has downloaded, the app works with no connection.
- **GPU acceleration** through WebGPU where available, otherwise multi-threaded CPU.

## Running it on your computer (development)

You need [Node.js 22 or newer](https://nodejs.org).

```bash
npm install
npm run dev
```

Open http://localhost:5173. Other commands:

| Command | What it does |
|---|---|
| `npm test` | Checks the separation maths and the WAV/FLAC/MP3 encoders (needs `ffmpeg` on your PATH for the encoder checks) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serves the production build at http://localhost:4173 |

## Putting the web app online for free (GitHub Pages)

1. Create a new repository on GitHub and push this folder to it:
   ```bash
   git remote add origin https://github.com/YOUR-NAME/stemdeck.git
   git push -u origin main
   ```
2. On GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The *Deploy web app* workflow runs on every push. When it finishes, the site is at `https://YOUR-NAME.github.io/stemdeck/`.

On a phone, open that address and choose **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

## Desktop app (Tauri)

### Easiest: let GitHub build the installers

Push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

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

### Unsigned-app warnings

The installers aren't code-signed, so people will see warnings the first time:

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
- **macOS:** Gatekeeper blocks the app. Right-click it and choose **Open**. If macOS says it's "damaged", run `xattr -cr /Applications/Stemdeck.app`.

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
  encode/              WAV, FLAC (own encoder) and MP3 (lamejs); runs in a worker
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
- **The Linux desktop app runs on CPU only**, because its webview (WebKitGTK) has no WebGPU. On Linux, Chrome or Edge running the web app is faster.
- **Memory:** a 4-minute song needs roughly 1–2 GB of RAM during separation. Very long files or 6-stem mode on phones can run out. Use the compact model and shorter files there.
- **iPhone/iPad:** works in recent Safari, but iOS may stop the app if you switch away during processing. Keep it in the foreground.
- **Fine-tuned + two-stem mode** runs only the one specialist model it needs and computes "everything else" as *original minus stem*. That's 4× faster, but not bit-identical to the Demucs CLI, which sums the other three stems.
- **Shifts** use random offsets, as in Demucs, so two runs with shifts > 1 differ very slightly.

## Credits and licences

- **Demucs** by Alexandre Défossez, Simon Rouard, Francisco Massa and Meta AI, MIT licence: https://github.com/adefossez/demucs
- **ONNX exports** by StemSplit (`StemSplitio/*` on Hugging Face), MIT licence.
- **ONNX Runtime Web** by Microsoft, MIT licence.
- **SoundTouchJS**, LGPL-2.1. It's used unmodified from npm, and you can swap in your own build of it.
- **lamejs** (MP3), LGPL. **fflate** (ZIP), MIT.
- Stemdeck itself: MIT (see `LICENSE`).

Only separate audio you have the right to use.
