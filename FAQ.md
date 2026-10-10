# Steminize: questions and answers

## Installing
**Windows says "Windows protected your PC".** The installer isn't code-signed yet. Click **More info**, then **Run anyway**.

**macOS says it can't verify the developer.** The app isn't signed or notarised yet. Open the `.dmg`, drag Steminize to Applications, then go to
**System Settings → Privacy & Security**, find the Steminize message and press **Open Anyway**. (On macOS 15 and later, right-click → Open no longer
does this.) If that doesn't work, run `xattr -dr com.apple.quarantine /Applications/Steminize.app` in Terminal and try again.

**Which Linux file do I use?** The `.deb` for Ubuntu, Linux Mint and Debian 12 or later; the `.rpm` for Fedora-type systems; the AppImage for anything
else (make it executable, then run it).

**MP3 or M4A files won't open on Linux.** Install the GStreamer libav plug-in: `sudo apt install gstreamer1.0-libav` (the AppImage already includes it).

## Separating songs
**What is downloaded, and how big is it?** The first time you pick a model, one file (about 140–660 MB depending on the model and precision) is downloaded
once and kept; after that the app works with no internet. Your songs are never uploaded.

**It's very slow.** Separation is heavy. Where the app can use the graphics card (WebGPU: the web app in a recent browser, and
the desktop app on systems whose web view supports it) it is quick; CPU-only (the Linux app, older machines) takes
several minutes per song, and the Fine-tuned model about four times longer. Try one short song first. The Compact (fp16) model is smaller.

**It's stuck on "Loading model…".** Wait: the first load can take a minute (the seconds are counted). If it never moves, open **Settings** and set **Device**
to **CPU**, then try again. Since 0.9.3 it falls back to the CPU by itself after a minute. If it still stalls, press **Copy diagnostic info** in About
and send it with a bug report.

**It says it ran out of memory.** Use a shorter file, the Compact model, or the CPU setting. Very long files (15 minutes or more) use several GB.

**Which model should I choose?** HT Demucs is fastest. The 6-stem model (the default) also splits out guitar and piano. Fine-tuned is the best quality but
about four times slower.

## Your library
**Where are my songs kept?** In the app's own storage on your computer. Use **Back up…** under the Library to save everything as one zip, and **Restore…** to
bring it back or move it to another computer. The app reminds you when it has been a while.

**I deleted a song by mistake.** It can't be undone unless you have a backup zip. Restoring a backup adds back songs you no longer have.

## Playing and recording
**The tempo or the chords are wrong.** Tempo can be corrected with ½×, 2× or tap in **Tempo & key**. Chords are a first draft (about 60–75% right): click one to
correct it, and the correction is kept.

**My recording is behind the song.** That's audio delay. In the normal engine, press **Measure** (with an output patched to an input) or use **Line up** under the
take. For much lower delay, try the **Native audio** row in the Live input drawer (desktop app): the README's "Getting the lowest delay" section has the steps.

**I can't hear myself / the level is low.** In **Live input**, check the right device, and use the channel choice (Input 1 or Input 2) if you play into one input of
an interface. The Level slider goes up to 4. If your interface has direct monitoring, switch it on and turn the app's Level down to 0: recording still works.

## The Scratchpad
**How do I write drums?** One row per kit piece, one column per sixteenth note: `HH|x-x-x-x-x-x-x-x-|`, `SD|----o-------o---|`, `BD|o-------o-o-----|`. The **Symbols**
button lists the characters; **Follow along** draws it as drum sheet music.

**How do I get a tab to follow the song?** Put the cursor on the first note, press **Tap ⏱** as that note plays, then **Follow along**.

## Reporting a problem
Use https://github.com/Gerschwin/steminize/issues/new/choose. It asks for the version, your computer, and the text from **Copy diagnostic info** (ⓘ in the top right),
which contains no songs or personal information.
