# In-app updates: how they work and what to keep safe

Steminize can update itself from inside the app (About → **Check for updates** → **Install and restart**).

## How it works
1. **Check for updates** asks GitHub for the newest *published* release (drafts are never offered).
2. If this install can update itself, **Install and restart** appears. It fetches that release's `latest.json`
   (`https://github.com/Gerschwin/steminize/releases/download/<tag>/latest.json`), downloads the update for this platform,
   checks its signature against the **public key built into the app** (`src-tauri/tauri.conf.json`), installs it and restarts.
3. An update that was not signed with the project's private key is refused. The app also only accepts addresses inside this
   project's own release downloads (`src-tauri/src/updater.rs`).

Who can update themselves: Windows (the `.exe` installer, passive mode), macOS (the `.app.tar.gz`), Linux **AppImage** only.
A `.deb` or `.rpm` is owned by the system's package manager, so those users get the download link as before.

This key signs *update files*. It is separate from code-signing certificates (Windows SmartScreen, Apple notarisation), which
are deferred.

## The key (do not lose it)
- Private key: `~/.tauri/steminize-updater.key` on Neil's computer (no password), also stored as the repository secret
  `TAURI_SIGNING_PRIVATE_KEY`. Public key: `~/.tauri/steminize-updater.key.pub` (it is in `tauri.conf.json`).
- **Back the private key file up somewhere safe** (a password manager or an encrypted drive). If it is lost, every installed copy
  stops being able to update until people reinstall by hand, because only the matching key can sign updates they will accept.
- If the key ever leaks, make a new one (`npx tauri signer generate -w ~/.tauri/steminize-updater.key -f`), put the new public
  key in `tauri.conf.json`, update the secret, and ask people to reinstall once.
- If you set a password on the key, also set the secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Releasing
The tag build now fails at once, with a clear message, if `TAURI_SIGNING_PRIVATE_KEY` is not set. With it set, each release
gets `latest.json` and a `.sig` file for each installer, uploaded by the build. Nothing else changes: create the draft, let the
build attach the files, publish the draft.

## Testing an update by hand
Install release N, publish release N+1, and in the installed app press Check for updates → Install and restart. The first real
test needs two published releases. (The pre-1.0 tags are all pre-releases; the app offers newer 0.x pre-releases to 0.x installs.)
