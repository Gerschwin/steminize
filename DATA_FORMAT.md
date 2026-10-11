# What Steminize saves, and the rules for changing it

Written 2026-10-11 for 0.9.4. People keep songs, tab, lyrics, takes and settings in this app for years, so what it saves has to keep
opening in every later version. This file describes what is saved and the rules that keep it safe. `tests/run.ts` checks the
rules against saved songs from every era (`tests/fixtures/library/`).

## Where things live

| What | Where | Notes |
|---|---|---|
| Songs and their audio | the **library**: `library/<song-id>/` | Desktop: plain files under the app's local-data folder. Web: the browser's private file storage (OPFS). Same layout on both. |
| A song's description | `library/<song-id>/meta.json` | JSON. Described below. Written **last** when a song is saved. |
| A song's audio | `library/<song-id>/<Track name>.flac` | One 16-bit FLAC per stem or track; the `scale` in meta.json undoes any level reduction. |
| A song's recorded takes | `library/<song-id>/<groupId>-<takeId>.flac` | Listed in meta.json under `takeGroups`. |
| Setlists | browser storage key `steminize.setlists.v1` | A list of `{ id, name, songs: [song ids], auto, gap }`. Read tolerantly (`parseSetlists`). |
| Separation settings | browser storage key `steminize.settings.v1` | Merged over the defaults, so a missing field takes its default. |
| Interface choices | browser storage keys `steminize.*` | Listed in `src/prefs.ts`. **Reset app preferences** removes them; it never touches songs or setlists. |
| Downloaded models | Cache Storage, `steminize-models-v1` | Unfinished downloads sit beside them as `…?steminize-part=0000`, `…0001` and so on. |
| A **backup** | one `.zip` | Entries are `<song-id>/<file>` for every file of every song (so `<song-id>/meta.json`, `<song-id>/Bass.flac`, …). Restoring skips songs already in the library. A backup from the web app restores on the desktop app and the other way round. |

The song id is the folder name: a date plus a random suffix, for example `2026-10-06-7n68ag`. It is the truth: if the id inside
`meta.json` ever differs, the folder name wins.

## `meta.json`

```text
id, title, seconds, created, bytes, settings, stems[], analysis?, kind?, took?, takeGroups?, state?
```

| Field | Meaning |
|---|---|
| `title` | Shown name. Missing or blank reads as "Untitled". |
| `seconds`, `bytes`, `created` | Length, size on disk, time saved (ms since 1970). Missing reads as 0. |
| `settings` | The separation settings used (model, stems, format …). Merged over the defaults. |
| `stems[]` | `{ name, scale }` per track: its file name and the level scale. **A song needs at least one**, or it cannot be opened and is skipped. |
| `kind` | `'separated'` or `'multitrack'`. Missing means separated (the earliest songs have none). |
| `analysis` | `{ bpm, beats[] (seconds), downbeat, key? }`: tempo and bar grid. Dropped if malformed (it is re-detected). |
| `takeGroups` | Recorded takes: `{ id, takes: [{ id, scale, note? }], activeTake? }`. |
| `state` | Everything about *playing* the song, owned by the player. Below. |

### `state` (the player's saved state)

`lanes[]` (per track: `vol`, `pan`, `mute`, `solo`, `eq?`, `height?`, `label?`), `loop {on,a,b}`, `tempo`, `pitch`, `practice`
(count-in, click, gap, speed trainer), `markers[]`, `practiceSeconds`, `lastPracticed`, and three groups:

- **`tx`** (notes, chords and the chord view): `notes`, `chords`, `source`, `chordList` (detected and corrected chords), `midi`,
  `notesHeight`; and from 0.9.4 `strip`, `simple`, `stripZoom`, `shapes` (`guitar` / `ukulele` / `piano`), `capo`.
- **`scratch`** (the Scratchpad): `lyrics`, `lyricsFollow`, `lyricsOffset`, `lyricsChords`, `notes`, and the tab fields (`tab`,
  `tabAnchors`, `tabFollow`, `tabStaff`, `tabTrainer`, `tabEar`, `tabBarScores`), plus the parts: `tabPart` (which part the top-level
  tab fields belong to), `tabParts` (the other parts' tab fields, by part id), `extraParts` (added parts: `{ id, name }`),
  `partNames` (renames), `partTracks` (which track each part is linked to).
- Anything else is kept as it is.

### When each field first appeared

| First released in | Fields |
|---|---|
| before 0.9.0 (v1.x numbering) | `kind`, `takeGroups`, `lyricsFollow`, `lyricsOffset`, `practiceSeconds`, `tabAnchors`, `tabFollow`, `tabStaff`, `tabTrainer`, `tabEar`; a separate drum grid text box (`scratch.drums`) |
| 0.9.3 | `tabBarScores` |
| 0.9.4 | `tabPart`, `tabParts`, `extraParts`, `partNames`, `partTracks` (the old single tab and the old `drums` box are moved into parts when a song is opened), `lyricsChords`, `tx.strip`, `tx.simple`, `tx.stripZoom`, `tx.shapes`, `tx.capo` |

## The rules (what keeps old and new songs working)

1. **Never remove or reinterpret a field.** A field that is no longer used is simply left alone in the file. Its meaning never
   changes: a new meaning gets a new name.
2. **New fields are optional.** A song saved before a field existed has to work; the reader supplies a default. `parseMeta`
   (`src/library/meta.ts`) does this for `meta.json`; `normaliseScratch` (`src/lyrics/tabParts.ts`) does it for the Scratchpad.
3. **Unknown fields are kept** where it can be done. At the top level of `meta.json` they are (a field a newer version wrote
   survives being opened and saved by an older one; tested). Inside `state` it is **not guaranteed**: the player rebuilds `state`
   from the fields it knows, so an older version that saves a song may drop a newer version's extra state fields (for example
   the chord view settings). That is a known limit, and the reason a backup before going back to an older version is a good idea.
4. **Damage skips one song, never the library.** A `meta.json` that is not JSON, not an object, or has no stems is skipped (the
   files stay where they are). A wrongly typed field is repaired or dropped; the song still opens.
5. **Nothing is deleted on a hunch.** A song folder with no `meta.json` is normally an interrupted save, but it could be a save in
   progress or a file locked for a moment. It is cleaned up only when the file is definitely missing **and** nothing in the
   folder has changed for a day (`canCleanIncompleteSong`, with the same rule in the desktop code, `src-tauri/src/library.rs`).
6. **Migrations are functions with tests.** When the way something is stored must change, write a function that brings old data
   up to date, make it return a new object (never change the input), make it safe to run twice, and add a fixture from the old
   layout to `tests/fixtures/library/`. `normaliseScratch` is the model.
7. **Audio files are never rewritten** by an update. Stems and takes are written once, when the song or take is saved.

## Adding a fixture

When a release changes what is saved, add a sanitised `meta.json` (no real titles or lyrics) from that release to
`tests/fixtures/library/` and run `npm test`: it opens every fixture, checks the saved state comes back unchanged, that opening and
saving again changes nothing, and that the Scratchpad migration loses no text.
