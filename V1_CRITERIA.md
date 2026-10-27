# Steminize 1.0: what has to be true

Written 2026-10-10 against the `native-audio` branch (0.9.6 released). 1.0 is the first public release, so this list is about trust and
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
- [ ] (Decided: stays off by default and labelled experimental until this is done.) Native audio on real hardware: playback and recording on Linux with an interface (playback tried; recording not yet), and a first try on Windows and macOS. Either proven, or kept labelled "experimental" with the normal engine as the default. (Both)

### 2. Installers that don't scare people
- [x] Windows code signing: **deferred, decided 2026-10-11** (free for now, unsure how much it will be used). 1.0 ships unsigned; the warning and the click-through are explained in the FAQ, the README and the release notes. Revisit when there is evidence of use (options: SignPath Foundation's free open-source signing, or a paid certificate / Azure Trusted Signing).
- [x] macOS signing and notarisation: **deferred, decided 2026-10-11**, same reasoning (the Apple Developer Program is about $99 a year). Unsigned 1.0 with the Open Anyway / `xattr` steps in the FAQ. This is the heavier friction of the two, so it is the first to sign if use justifies it.
- [ ] In-app update that downloads and installs: **built 2026-10-11** (Install and restart in About; signed update files; see `UPDATER.md`). A local AppImage build produced the signed update file. The repository secret `TAURI_SIGNING_PRIVATE_KEY` was set on 2026-10-11. Still to do before this can be ticked: Neil backs the key file up, then two published releases are needed to try an update for real.

### 3. A good first run
- [x] A short welcome (the panel shown when no song is open): what the app is for, three ways to start, what the first split downloads (model name and size, whether it is already here), and that nothing is uploaded. A "Try a sample song" button is built in and hidden until a sample exists.
- [x] A bundled sample song so a new user can try the player before importing or downloading a model: an original, synthesised piece with a finished, timed guitar tab (`public/sample/example-tab`, made by `tools/make-example-song.py`; three small MP3 stems, under 1 MB), opened by the welcome screen's "Try a sample song" button. Added 2026-10-27; it is a demo of the tab view rather than of separation, since the stems are synthesised.
- [x] A clear message when a song is too long or the machine too small: a warning before separating a long file, and the out-of-memory message already in place.
- [x] The model download explains itself (the welcome panel and Models say the size, that it is one-off and works offline afterwards), can be stopped (Stop in Models, or cancelling the song in the queue) and carries on from where it got to (Resume in Models, or just separate again).

### 4. Data safety
- [x] Older saved songs are brought up to date by one tested function (`normaliseScratch`), covering the single-tab, old drum box and deleted-part cases. A written-down format description (`DATA_FORMAT.md`) and tests that open saved songs from every era (`tests/fixtures/library/`, sanitised copies of real saved songs) were added 2026-10-11.
- [x] A disk-space check before saving a song, and a "last backed up" reminder under the Library.
- [x] Back up and restore the whole library as one zip.

### 5. Legal and licensing
- [x] A full dependency licence report (`LICENCES.md`, regenerate with `node scripts/licence-report.mjs`). Findings: two LGPL web libraries (soundtouchjs, lamejs) that matter only for a closed-source version, a few unmodified MPL Rust crates, and one dev-only build tool. Still to do for Neil: read it before deciding on a paid version.
- [x] **From YouTube** decision: **opt-in, decided 2026-10-11.** Off by default, switched on under Settings → From YouTube after a notice (only download audio you own, that is royalty-free or Creative Commons, or that you have the right to use; it can break YouTube's terms; you are responsible). yt-dlp is still fetched at runtime, never bundled. Still to do: don't promote it on the website.
- [x] Decision on the licence and any paid version: **decided 2026-10-11, free and open source (MIT) with optional donations** (donationware). Nothing is held back behind a payment, which matches the README, About and the Sponsor button as they already are.
- [x] About shows what uses the network, credits and licences; nothing is uploaded.
- [x] A privacy statement (`PRIVACY.md`, matching the About dialog).

### 6. Help and a front door
- [x] README with features, install steps and honest limitations.
- [x] An FAQ (`FAQ.md`, including the unsigned-installer steps and how to report a bug). A getting-started page with screenshots is at `/guide/` on the website (`public/guide/index.html`), linked from About; it goes live when `native-audio` is merged into `main`.
- [x] Bug-report and suggestion templates on GitHub that ask for the Copy diagnostic info text.
- [x] Release notes on every release (the changelog).

## Should have
- [x] Unsaved songs in the native engine now say clearly that they use the normal engine.
- [x] Accessibility basics (done 2026-10-11, see the Accessibility section of the README): focus ring; names on every control and canvas; keyboard access to library, queue, setlist and lyric rows; an automatic contrast check in both themes with the failures fixed; a Text size setting (desktop) and a layout that wraps at large sizes; keyboard walk-through of the main window. Still worth doing with real people: a screen-reader pass (NVDA / VoiceOver / Orca). (Claude)
- [x] Desktop-only features say so in the interface: the browser's Settings has a Desktop app card listing native audio, From YouTube, saving into a folder and big files, with a link to the releases page.
- [x] Settings: a Reset for app preferences that never touches songs or setlists (separation settings already had one).
- [x] Merged `native-audio` into `main` on 2026-10-11 (Neil said go; a fast-forward, 179 commits), which redeployed the web app at https://gerschwin.github.io/steminize/. From now on `main` is what the public sees: keep working on `native-audio` and merge deliberately.

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
1. ~~Code signing~~ **Decided 2026-10-11: release unsigned for now**, with clear instructions; revisit once there is evidence of use.
2. ~~From YouTube: keep, make optional, or remove?~~ **Decided 2026-10-11: opt-in with a notice.**
3. ~~Native audio at 1.0~~ **Decided 2026-10-11: off by default until fully tested, but easy to find and known to exist** (a tip in the Live input drawer, a Settings card with a Show me where button, a line on the welcome panel; all desktop only). Turn it on by default only once it has been proven on real Windows, macOS and Linux hardware.
4. ~~Free, paid or pay-what-you-want?~~ **Decided 2026-10-11: free (MIT) with optional donations.** The website page should say so plainly.
5. **Sample song:** which royalty-free song to bundle?
6. **When is it "ready"?** Suggested rule: every Must have ticked, plus two weeks of testers with no new serious bug.

## Suggested path
0.9.6 (parts, drums, chord view, DAW export, updater, accessibility, Learn) → test round on all three platforms → fix → 0.10.0 (welcome screen, sample song, in-app update, data-format tests) → (signing only if use justifies it) → release candidate → 1.0.
