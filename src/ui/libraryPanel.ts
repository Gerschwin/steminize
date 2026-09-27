import { background as encoder } from '../encode/client.ts';
import { addTake, deleteSong, exportLibrary, importLibrary, libraryAvailable, listSongs, loadStems, loadTake, removeTake, saveSong, writeMeta, type Analysis, type LibMeta, type TakeGroupMeta } from '../library.ts';
import { saveFile } from '../platform.ts';
import type { Deck, DeckState, Result } from './deck.ts';
import type { KeyCandidate } from '../analysis/key.ts';
import { $, fmtMB, fmtTime, h, toast } from './dom.ts';

const pref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};

function monoOf(use: Result['stems']): Float32Array {
  const n = use[0].data[0].length;
  const mono = new Float32Array(n);
  for (const s of use) for (let i = 0; i < n; i++) mono[i] += (s.data[0][i] + s.data[1][i]) / 2;
  return mono;
}

/** Tempo: the drum stem if there is one, else everything but vocals. Key: everything but drums. */
function analysisSources(stems: Result['stems']) {
  const drums = stems.find((s) => s.name === 'drums');
  const noVox = stems.filter((s) => s.name !== 'vocals');
  const rhythm = monoOf(drums ? [drums] : noVox.length ? noVox : stems);
  const tonal = stems.filter((s) => s.name !== 'drums');
  return { rhythm, harmonic: monoOf(tonal.length ? tonal : stems) };
}

type Onsets = { env: Float32Array; low: Float32Array };
async function analyse(r: Result): Promise<Analysis & Onsets> {
  const { rhythm, harmonic } = analysisSources(r.stems);
  const req = { type: 'beats' as const, mono: rhythm, harmonic };
  return encoder.run<Analysis & Onsets>(req);
}

export function initLibrary(deck: Deck) {
  const metas = new Map<string, LibMeta>();
  const list = $('libList');
  const autoSave = $<HTMLInputElement>('autoSave');
  autoSave.checked = pref('steminize.autoSave', '1') === '1';
  autoSave.onchange = () => {
    try {
      localStorage.setItem('steminize.autoSave', autoSave.checked ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  if (!libraryAvailable()) {
    $('libraryCard').hidden = true;
  } else {
    $('libBackupBar').hidden = false;
  }

  // ---- saving player state (debounced) ----
  let timer = 0;
  deck.onStateChange = (state: DeckState) => {
    const id = deck.current?.libId;
    const meta = id && metas.get(id);
    if (!meta) return;
    meta.state = state;
    clearTimeout(timer);
    timer = window.setTimeout(() => writeMeta(meta).catch(() => {}), 800);
  };
  deck.onAnalysisChange = (r) => {
    const meta = r.libId && metas.get(r.libId);
    if (meta && r.analysis) {
      meta.analysis = r.analysis;
      writeMeta(meta).catch(() => {});
    }
  };
  deck.onRename = (title) => {
    const id = deck.current?.libId;
    const meta = id && metas.get(id);
    if (!meta) return;
    meta.title = title;
    writeMeta(meta).catch(() => {});
    render();
  };
  /** Finds a song's take-group entry by id, creating it if this is its first take. */
  function takeGroup(meta: LibMeta, groupId: string): TakeGroupMeta {
    meta.takeGroups ??= [];
    let g = meta.takeGroups.find((x) => x.id === groupId);
    if (!g) {
      g = { id: groupId, takes: [] };
      meta.takeGroups.push(g);
    }
    return g;
  }
  deck.onTakeAdded = async (groupId, take) => {
    const id = deck.current?.libId;
    const meta = id && metas.get(id);
    if (!meta) return; // song isn't kept in the library (yet): the take only lives in this session
    const tm = await addTake(meta, groupId, take);
    const g = takeGroup(meta, groupId);
    g.takes = [...g.takes, tm];
    g.activeTake = take.id;
    await writeMeta(meta);
  };
  deck.onTakeSelected = (groupId, takeId) => {
    const id = deck.current?.libId;
    const meta = id && metas.get(id);
    if (!meta) return;
    takeGroup(meta, groupId).activeTake = takeId;
    writeMeta(meta).catch(() => {});
  };
  deck.onTakeRemoved = async (groupId, takeId) => {
    const id = deck.current?.libId;
    const meta = id && metas.get(id);
    if (!meta) return;
    const g = takeGroup(meta, groupId);
    g.takes = g.takes.filter((t) => t.id !== takeId);
    await removeTake(meta, groupId, takeId);
    await writeMeta(meta);
  };
  deck.onTakeNoteChanged = (groupId, takeId, note) => {
    const id = deck.current?.libId;
    const meta = id && metas.get(id);
    if (!meta) return;
    const t = takeGroup(meta, groupId).takes.find((x) => x.id === takeId);
    if (t) t.note = note || undefined;
    writeMeta(meta).catch(() => {});
  };
  deck.rankKeys = (r, start, end) => {
    const { harmonic } = analysisSources(r.stems);
    const seg = start != null && end != null ? harmonic.slice(Math.max(0, Math.round(start)), Math.round(end)) : harmonic;
    return encoder.run<KeyCandidate[]>({ type: 'keys', harmonic: seg });
  };
  deck.needOnsets = async (r) => {
    const a = await analyse(r);
    return { env: a.env, low: a.low };
  };

  const exportBtn = $<HTMLButtonElement>('libExport');
  const importInput = $<HTMLInputElement>('libImport');

  let onChange: () => void = () => {};

  function render() {
    const songs = [...metas.values()].sort((a, b) => b.created - a.created);
    list.replaceChildren(...songs.map(item));
    const total = songs.reduce((a, s) => a + (s.bytes || 0), 0);
    $('libInfo').textContent = songs.length
      ? `${songs.length} song${songs.length > 1 ? 's' : ''} · ${fmtMB(total)} on this computer`
      : "Separated songs are kept here so you don't have to wait again.";
    exportBtn.disabled = !songs.length;
    onChange();
  }

  exportBtn.onclick = async () => {
    const label = exportBtn.textContent;
    exportBtn.disabled = true;
    try {
      const zip = await exportLibrary((done, total) => (exportBtn.textContent = `Zipping… ${done}/${total}`));
      const date = new Date().toISOString().slice(0, 10);
      const saved = await saveFile(`steminize-library-${date}.zip`, zip, 'application/zip');
      if (saved) toast(`Backed up ${metas.size} song${metas.size > 1 ? 's' : ''}.`);
    } catch (e) {
      toast(`Couldn't back up the library: ${(e as Error).message}`, true);
    } finally {
      exportBtn.textContent = label;
      exportBtn.disabled = !metas.size;
    }
  };

  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    const note = toast('Reading backup…', false, 600_000);
    try {
      const zip = new Uint8Array(await file.arrayBuffer());
      const { imported, skipped } = await importLibrary(zip, (done, total) => (note.textContent = `Restoring… ${done}/${total}`));
      for (const m of await listSongs()) metas.set(m.id, m);
      render();
      note.remove();
      toast(imported ? `Added ${imported} song${imported > 1 ? 's' : ''}${skipped ? ` (${skipped} already in your library)` : ''}.` : `Nothing new to add${skipped ? ` (${skipped} already in your library)` : ''}.`);
    } catch (e) {
      note.remove();
      toast(`Couldn't restore that backup: ${(e as Error).message}`, true);
    }
  };

  function item(m: LibMeta) {
    const date = new Date(m.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const stems = m.kind === 'multitrack' ? `${m.stems.length} tracks` : m.settings?.twoStems ? `${m.settings.twoStems}/rest` : `${m.stems.length} stems`;
    const sub = h('div', { class: 't-sub' }, [fmtTime(m.seconds), stems, m.analysis ? `${Math.round(m.analysis.bpm)} BPM` : '', fmtMB(m.bytes), date].filter(Boolean).join(' · '));
    const x = h('button', { class: 't-x', type: 'button', title: 'Delete from library' }, '×');
    // Single click opens, but waits a moment so a double-click (rename) doesn't open it first.
    let openTimer = 0;
    const nameEl = h('div', { class: 't-name', title: `${m.title}\n(double-click to rename)` }, m.title);
    nameEl.ondblclick = (e) => {
      e.stopPropagation();
      clearTimeout(openTimer);
      const input = h('input', { type: 'text', value: m.title, maxLength: 120, class: 't-name-edit', 'aria-label': 'Song title' } as any);
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        if (save && val && val !== m.title) {
          m.title = val;
          writeMeta(m).catch(() => {});
          if (deck.current?.libId === m.id) {
            deck.current.title = val;
            $('trackTitle').textContent = val;
          }
        }
        render();
      };
      input.onclick = (ev) => ev.stopPropagation();
      input.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        if (ev.key === 'Escape') finish(false);
      };
      input.onblur = () => finish(true);
      nameEl.replaceWith(input);
      input.focus();
      input.select();
    };
    const li = h('li', { class: `track done${deck.current?.libId === m.id ? ' active' : ''}` }, nameEl, x, sub);
    x.onclick = async (e) => {
      e.stopPropagation();
      if (!x.classList.contains('confirm')) {
        x.classList.add('confirm');
        x.textContent = 'Delete?';
        setTimeout(() => {
          x.classList.remove('confirm');
          x.textContent = '×';
        }, 3000);
        return;
      }
      await deleteSong(m.id).catch((err) => toast(`Couldn't delete: ${err.message}`, true));
      metas.delete(m.id);
      if (deck.current?.libId === m.id) deck.current.libId = undefined;
      render();
    };
    li.onclick = () => {
      if (deck.current?.libId === m.id) return;
      clearTimeout(openTimer);
      openTimer = window.setTimeout(async () => {
        sub.textContent = 'Opening…';
        await openSong(m.id);
        render();
      }, 250);
    };
    return li;
  }

  /** Loads a library song into the deck, restoring its saved mixer, tempo, pitch, loop and lyrics. False if it couldn't be opened. */
  async function openSong(id: string): Promise<boolean> {
    const m = metas.get(id);
    if (!m) return false;
    try {
      const stems = await loadStems(m);
      const takeGroups = m.takeGroups?.length
        ? await Promise.all(
            m.takeGroups.map(async (g: TakeGroupMeta) => ({
              id: g.id,
              activeTake: g.activeTake,
              takes: await Promise.all(g.takes.map(async (t) => ({ id: t.id, data: await loadTake(m.id, g.id, t), note: t.note }))),
            })),
          )
        : undefined;
      const r: Result = { title: m.title, stems, settings: m.settings, seconds: m.seconds, took: m.took, libId: m.id, analysis: m.analysis, kind: m.kind, takeGroups };
      deck.open(r, m.state as DeckState | undefined);
      onOpen(r);
      // Songs saved before key detection existed: work it out now, keep any tempo corrections.
      if (m.analysis && !m.analysis.key) {
        void analyse(r).then((a) => {
          if (!a.key || !r.analysis) return;
          r.analysis = { ...r.analysis, key: a.key };
          r.onsets ??= { env: a.env, low: a.low };
          m.analysis = r.analysis;
          if (deck.current === r) deck.setAnalysis(r.analysis);
          writeMeta(m).catch(() => {});
        });
      }
      return true;
    } catch (err) {
      toast(`Couldn't open ${m.title}: ${(err as Error).message}`, true);
      return false;
    }
  }

  let onOpen: (r: Result) => void = () => {};

  /** After a separation: analyse the tempo, then (optionally) save to the library. */
  async function afterSeparation(r: Result) {
    try {
      const a = await analyse(r);
      r.analysis = { bpm: a.bpm, beats: a.beats, downbeat: a.downbeat, key: a.key };
      r.onsets = { env: a.env, low: a.low };
      if (deck.current === r) deck.setAnalysis(r.analysis);
    } catch (e) {
      console.warn('Tempo analysis failed', e);
    }
    if (!autoSave.checked || !libraryAvailable()) return;
    try {
      // Only meaningful for the OPFS backend (asks the browser not to evict the library under storage
      // pressure); navigator.storage doesn't exist at all in WebKitGTK, so this must be optional too.
      navigator.storage?.persist?.().catch(() => {});
      const meta = await saveSong(
        { title: r.title, seconds: r.seconds, took: r.took, created: Date.now(), settings: r.settings, kind: r.kind, analysis: r.analysis, state: deck.current === r ? deck.getState() : undefined },
        r.stems,
      );
      metas.set(meta.id, meta);
      r.libId = meta.id;
      // Settings changed while saving? Store the latest.
      if (deck.current === r) {
        meta.state = deck.getState();
        await writeMeta(meta);
      }
      render();
    } catch (e) {
      toast(`Couldn't save to the library: ${(e as Error).message}`, true);
    }
  }

  /** True once the stored songs have been read; before that the list is empty only because it hasn't arrived. */
  let loaded = false;
  async function load() {
    try {
      for (const m of await listSongs()) metas.set(m.id, m);
      loaded = true;
    } catch (e) {
      console.warn('Library unavailable', e);
      toast(`Couldn't read your library: ${(e as Error).message}`, true);
    }
    render();
  }
  void load();

  return {
    afterSeparation,
    stateFor: (r: Result) => (r.libId ? (metas.get(r.libId)?.state as DeckState | undefined) : undefined),
    set onOpen(f: (r: Result) => void) {
      onOpen = f;
    },
    /** Called whenever the list of songs (or their settings shown in it) changes. */
    set onChange(f: () => void) {
      onChange = f;
    },
    songs: () => [...metas.values()],
    loaded: () => loaded,
    openSong,
    refresh: render,
  };
}
