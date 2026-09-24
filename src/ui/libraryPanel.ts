import { background as encoder } from '../encode/client.ts';
import { deleteSong, libraryAvailable, listSongs, loadStems, saveSong, writeMeta, type Analysis, type LibMeta } from '../library.ts';
import type { Deck, DeckState, Result } from './deck.ts';
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
  autoSave.checked = pref('stemdeck.autoSave', '1') === '1';
  autoSave.onchange = () => {
    try {
      localStorage.setItem('stemdeck.autoSave', autoSave.checked ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  if (!libraryAvailable()) {
    $('libraryCard').hidden = true;
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
  deck.needOnsets = async (r) => {
    const a = await analyse(r);
    return { env: a.env, low: a.low };
  };

  function render() {
    const songs = [...metas.values()].sort((a, b) => b.created - a.created);
    list.replaceChildren(...songs.map(item));
    const total = songs.reduce((a, s) => a + (s.bytes || 0), 0);
    $('libInfo').textContent = songs.length
      ? `${songs.length} song${songs.length > 1 ? 's' : ''} · ${fmtMB(total)} on this computer`
      : "Separated songs are kept here so you don't have to wait again.";
  }

  function item(m: LibMeta) {
    const date = new Date(m.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const stems = m.settings?.twoStems ? `${m.settings.twoStems}/rest` : `${m.stems.length} stems`;
    const sub = h('div', { class: 't-sub' }, [fmtTime(m.seconds), stems, m.analysis ? `${Math.round(m.analysis.bpm)} BPM` : '', fmtMB(m.bytes), date].filter(Boolean).join(' · '));
    const x = h('button', { class: 't-x', type: 'button', title: 'Delete from library' }, '×');
    const li = h('li', { class: `track done${deck.current?.libId === m.id ? ' active' : ''}` }, h('div', { class: 't-name', title: m.title }, m.title), x, sub);
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
    li.onclick = async () => {
      if (deck.current?.libId === m.id) return;
      sub.textContent = 'Opening…';
      try {
        const stems = await loadStems(m);
        const r: Result = { title: m.title, stems, settings: m.settings, seconds: m.seconds, took: m.took, libId: m.id, analysis: m.analysis };
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
      } catch (err) {
        toast(`Couldn't open ${m.title}: ${(err as Error).message}`, true);
      }
      render();
    };
    return li;
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
      navigator.storage.persist?.().catch(() => {});
      const meta = await saveSong(
        { title: r.title, seconds: r.seconds, took: r.took, created: Date.now(), settings: r.settings, analysis: r.analysis, state: deck.current === r ? deck.getState() : undefined },
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

  async function load() {
    try {
      for (const m of await listSongs()) metas.set(m.id, m);
    } catch (e) {
      console.warn('Library unavailable', e);
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
    refresh: render,
  };
}
