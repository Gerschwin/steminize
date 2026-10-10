# Steminize 1.0: what has to be true

Written 2026-10-10 against the `native-audio` branch (0.9.3 released). 1.0 is the first public release, so this list is about trust and
polish more than new features. Tick items as they are done. **Owner**: Neil = a decision or action only Neil can take; Claude = built
and fixed by Claude; Both = needs real hardware or a person plus a fix.

Anything not listed here (the chord view, MIDI input, themes, JACK / ASIO, and so on) is in `BACKLOG.md` as an idea and is not
needed for 1.0.

## Must have

### 1. Proven on every platform
- [ ] Windows: a clean install, separate a song, play, loop, record, export. The model-load watchdog and the YouTube window fix (0.9.3) confirmed on a real machine. (Both)
- [ ] macOS: the same, on an Intel and an Apple-chip Mac if possible. Never tried yet. (Both)
- [ ] Linux: `.deb`, `.rpm` and AppImage each install and run on a real machine. The AppImage was checked in a virtual display; the others by the maintainer. (Both)
- [ ] `TEST_CHECKLIST.md` run in full, and every failure fixed or written down as a known limit. (Both)
- [ ] Native audio on real hardware: playback and recording on Linux with an interface (playback tried; recording not yet), and a first try on Windows and macOS. Either proven, or kept labelled "experimental" with the normal engine as the default. (Both)

### 2. Installers that don't scare people
- [ ] Windows code signing, so there is no "Windows protected your PC" warning. Costs money each year. (Neil to decide, Claude to wire into the build)
- [ ] macOS signing and notarisation, so there is no "can't verify the developer" block. Needs an Apple developer account. (Neil to decide, Claude to wire into the build)
- [ ] In-app update that downloads and installs, not only "a newer version exists" (Tauri updater with signed update files). (Claude)

### 3. A good first run
- [ ] A short welcome: what the app does, what will be downloaded and how big it is, and that nothing is uploaded. (Claude)
- [ ] A bundled sample song (royalty-free) so a new user can try the player before importing or downloading a model. Needs a song with a usable licence. (Neil to choose, Claude to add)
- [ ] A clear message when a song is too long or the machine too small (memory), instead of a stall or a crash. (Claude)
- [ ] The model download explains itself (size, one-off, works offline afterwards) and can be cancelled and resumed. (Claude)

### 4. Data safety
- [ ] The saved-song format is frozen, with tests that open songs saved by older versions, so an update never loses a library. (Claude)
- [ ] A disk-space check before saving a song, and a reminder to back up. (Claude)
- [x] Back up and restore the whole library as one zip.

### 5. Legal and licensing
- [ ] A full dependency licence report (npm and Rust), checked against the MIT licence and the About credits. (Claude)
- [ ] Decision on **From YouTube**: remove, make opt-in, or keep, given the platform-terms risk. (Neil)
- [ ] Decision on the licence and any paid version before 1.0 (see the paid-version note in `BACKLOG.md`). Published code stays MIT either way. (Neil)
- [x] About shows what uses the network, credits and licences; nothing is uploaded.
- [ ] A short privacy statement on the website. (Claude)

### 6. Help and a front door
- [x] README with features, install steps and honest limitations.
- [ ] A simple website or page with screenshots, a getting-started guide, an FAQ (including the unsigned-installer steps until signing is done) and how to report a bug. (Claude)
- [ ] A bug-report template on GitHub that asks for the Copy diagnostic info text. (Claude)
- [x] Release notes on every release (the changelog).

## Should have
- [ ] Unsaved songs in the native engine: auto-save them, or say clearly that they use the normal engine. (Claude)
- [ ] Accessibility basics: keyboard navigation through the main controls, readable contrast, a larger-text option, and bar-accuracy colours that don't rely on red / green alone. (Claude)
- [ ] Desktop-only features say so in the interface (native audio, From YouTube) instead of just being absent in the browser. (Claude)
- [ ] Settings: a reset-to-defaults, and one place that shows every setting. (Claude)
- [ ] Merge `native-audio` into `main` (this redeploys the website). Only after the checklist run. (Neil to say go, Claude to do)

## Already in place for 1.0
- [x] Stem separation (three models, all the Demucs options), batch queue, open multitrack, From YouTube (desktop), offline use, GPU or CPU.
- [x] The practice player: mixer, per-track EQ, loops, tempo and pitch, markers, zoom, beat lines, count-in, click, speed trainer (including the accuracy-gated one), hands-free keys.
- [x] Library and setlist, with per-song settings kept.
- [x] Notes view, Freeze, Chords with correction and chart export, To MIDI, Tuner.
- [x] Live input, recording, takes, punch-in, latency tools, input channel choice.
- [x] Tab+: Guitar, Bass and added parts, engraved Follow along, Trainer, bar-accuracy colours, drum staff with follow-along, parts linked to tracks, lyrics with sync.
- [x] Native audio engine (experimental), device-loss fallback, load and dropout counters.
- [x] Dark theme by default with no flash at start; installers for Windows, macOS and Linux built by CI.

## Decisions waiting for Neil
1. **Code signing:** buy and set up Windows and Apple signing, or release 1.0 unsigned with clear instructions? (Money, and the first impression.)
2. **From YouTube:** keep, make optional, or remove for the public release?
3. **Native audio at 1.0:** on by default, off by default, or labelled experimental?
4. **Free, paid or pay-what-you-want?** Decide before 1.0 so the licence and the website are right.
5. **Sample song:** which royalty-free song to bundle?
6. **When is it "ready"?** Suggested rule: every Must have ticked, plus two weeks of testers with no new serious bug.

## Suggested path
0.9.4 (parts, drums, theme fix) → test round on all three platforms → fix → 0.10.0 (welcome screen, sample song, in-app update, data-format tests) → signing → release candidate → 1.0.
