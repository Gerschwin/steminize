# Steminize 1.0: what has to be true

Written 2026-10-10 against the `native-audio` branch (0.9.4 released). 1.0 is the first public release, so this list is about trust and
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
- [x] A short welcome (the panel shown when no song is open): what the app is for, three ways to start, what the first split downloads (model name and size, whether it is already here), and that nothing is uploaded. A "Try a sample song" button is built in and hidden until a sample exists.
- [ ] A bundled sample song (royalty-free) so a new user can try the player before importing or downloading a model. Needs a song with a usable licence. (Neil to choose, Claude to add)
- [x] A clear message when a song is too long or the machine too small: a warning before separating a long file, and the out-of-memory message already in place.
- [ ] The model download explains itself (done: the welcome panel and Models say the size, that it is one-off and works offline afterwards) and can be cancelled (done) and resumed (not done: a cancelled download starts again from the beginning). (Claude)

### 4. Data safety
- [x] Older saved songs are brought up to date by one tested function (`normaliseScratch`), covering the single-tab, old drum box and deleted-part cases. Still to do: a frozen written-down format description and tests with real saved files from each release.
- [x] A disk-space check before saving a song, and a "last backed up" reminder under the Library.
- [x] Back up and restore the whole library as one zip.

### 5. Legal and licensing
- [x] A full dependency licence report (`LICENCES.md`, regenerate with `node scripts/licence-report.mjs`). Findings: two LGPL web libraries (soundtouchjs, lamejs) that matter only for a closed-source version, a few unmodified MPL Rust crates, and one dev-only build tool. Still to do for Neil: read it before deciding on a paid version.
- [ ] Decision on **From YouTube**: remove, make opt-in, or keep, given the platform-terms risk. (Neil)
- [ ] Decision on the licence and any paid version before 1.0 (see the paid-version note in `BACKLOG.md`). Published code stays MIT either way. (Neil)
- [x] About shows what uses the network, credits and licences; nothing is uploaded.
- [x] A privacy statement (`PRIVACY.md`, matching the About dialog).

### 6. Help and a front door
- [x] README with features, install steps and honest limitations.
- [x] An FAQ (`FAQ.md`, including the unsigned-installer steps and how to report a bug). Still to do: a simple website page with screenshots and a getting-started guide.
- [x] Bug-report and suggestion templates on GitHub that ask for the Copy diagnostic info text.
- [x] Release notes on every release (the changelog).

## Should have
- [x] Unsaved songs in the native engine now say clearly that they use the normal engine.
- [ ] Accessibility basics: done so far: a visible keyboard focus ring everywhere, and bar-accuracy colours also shown by an outline (dashed or heavy). Still to do: a keyboard walk-through of the main controls, a contrast check, and a larger-text option. (Claude)
- [ ] Desktop-only features say so in the interface (native audio, From YouTube) instead of just being absent in the browser. (Claude)
- [x] Settings: a Reset for app preferences that never touches songs or setlists (separation settings already had one).
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
0.9.4 (parts, drums, chord view, theme fix) → test round on all three platforms → fix → 0.10.0 (welcome screen, sample song, in-app update, data-format tests) → signing → release candidate → 1.0.
