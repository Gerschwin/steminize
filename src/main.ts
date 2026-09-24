import './styles.css';
import { Engine } from './engine/client.ts';
import type { Stereo } from './engine/separate.ts';
import { MODELS, neededFiles } from './models.ts';
import { isTauri } from './platform.ts';
import { loadSettings, type Settings } from './settings.ts';
import { Deck, type Result } from './ui/deck.ts';
import { $, fmtEta, fmtTime, h, toast } from './ui/dom.ts';
import { ensureDownloaded, initModelsDialog, onModelsChanged } from './ui/modelsDialog.ts';
import { SettingsPanel } from './ui/settingsPanel.ts';

// ---------------------------------------------------------------- setup
registerServiceWorker();
const settings = new SettingsPanel(loadSettings());
const deck = new Deck(() => settings.s);
const engine = new Engine();
initModelsDialog();
onModelsChanged.add(() => settings.render());

const chip = $('backendChip');
chip.textContent = 'gpu' in navigator ? 'GPU available' : 'CPU only';
engine.onBackend = ({ backend, threads, note }) => {
  chip.textContent = backend === 'webgpu' ? 'Running on GPU' : `Running on CPU · ${threads} thread${threads > 1 ? 's' : ''}`;
  chip.className = `chip${backend === 'webgpu' ? ' gpu' : ''}`;
  if (note) toast(note, true);
};

// ---------------------------------------------------------------- queue
type Status = 'queued' | 'downloading' | 'decoding' | 'separating' | 'done' | 'error' | 'cancelled';
interface Track {
  id: string;
  file: File;
  status: Status;
  text: string;
  frac: number; // -1 = indeterminate
  result?: Result;
  el: HTMLLIElement;
}
const tracks: Track[] = [];
let busy = false;

function addFiles(files: Iterable<File>) {
  let added = 0;
  for (const file of files) {
    if (!/^audio\/|^video\//.test(file.type) && !/\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?|webm|mp4)$/i.test(file.name)) continue;
    const t: Track = { id: crypto.randomUUID(), file, status: 'queued', text: 'Waiting…', frac: 0, el: h('li') };
    tracks.push(t);
    $('queue').append(t.el);
    renderTrack(t);
    added++;
  }
  if (!added) toast('No audio files found in that selection.', true);
  refreshQueue();
  void pump();
}

function renderTrack(t: Track) {
  const active = deck.current && t.result === deck.current;
  t.el.className = `track ${t.status}${active ? ' active' : ''}`;
  const running = ['downloading', 'decoding', 'separating'].includes(t.status);
  const x = h('button', { class: 't-x', type: 'button', title: running ? 'Cancel' : 'Remove' }, '×');
  x.onclick = (e) => {
    e.stopPropagation();
    removeTrack(t);
  };
  const bar = h('div', { class: `bar${running && t.frac < 0 ? ' indet' : ''}` }, h('i', { style: `width:${Math.max(0, t.frac) * 100}%` }));
  t.el.replaceChildren(h('div', { class: 't-name', title: t.file.name }, t.file.name), x, h('div', { class: 't-sub' }, t.text), running || t.status === 'queued' ? bar : '');
  t.el.onclick = () => t.result && openTrack(t);
}

function refreshQueue() {
  $('queueEmpty').hidden = tracks.length > 0;
  $('clearDone').hidden = !tracks.some((t) => ['done', 'error', 'cancelled'].includes(t.status));
  tracks.forEach(renderTrack);
}

function openTrack(t: Track) {
  deck.open(t.result!);
  refreshQueue();
  if (matchMedia('(max-width: 900px)').matches) $('deck').scrollIntoView({ behavior: 'smooth' });
}

function removeTrack(t: Track) {
  if (['downloading', 'decoding', 'separating'].includes(t.status)) {
    engine.cancel(t.id);
    t.status = 'cancelled';
    t.text = 'Cancelling…';
    renderTrack(t);
    return;
  }
  tracks.splice(tracks.indexOf(t), 1);
  t.el.remove();
  if (t.result && deck.current === t.result) deck.close();
  refreshQueue();
}

$('clearDone').onclick = () => {
  for (const t of [...tracks]) if (['done', 'error', 'cancelled'].includes(t.status) && t.result !== deck.current) removeTrack(t);
};

deck.onRerun = () => {
  const t = tracks.find((x) => x.result === deck.current);
  if (!t) return;
  addFiles([t.file]);
  toast('Queued again with the current settings');
};

async function pump() {
  if (busy) return;
  const t = tracks.find((x) => x.status === 'queued');
  if (!t) return;
  busy = true;
  try {
    await processTrack(t);
  } finally {
    busy = false;
    refreshQueue();
    void pump();
  }
}

async function decode(file: File): Promise<Stereo> {
  const bytes = await file.arrayBuffer();
  // Decoding in a 44.1 kHz context resamples to the model's rate.
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const buf = await ctx.decodeAudioData(bytes);
  const l = buf.getChannelData(0).slice();
  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : l.slice();
  return [l, r];
}

async function processTrack(t: Track) {
  const s: Settings = structuredClone(settings.s);
  const set = (status: Status, text: string, frac = t.frac) => {
    if (t.status === 'cancelled') return;
    Object.assign(t, { status, text, frac });
    renderTrack(t);
  };
  const check = () => {
    if (t.status === 'cancelled') throw Object.assign(new Error('Cancelled'), { name: 'Cancelled' });
  };
  try {
    set('downloading', 'Checking model…', -1);
    await ensureDownloaded(neededFiles(s.model, s.precision, s.twoStems, s.skipStems), (f, label) => set('downloading', label, f));
    check();
    set('decoding', 'Reading audio…', -1);
    const mix = await decode(t.file);
    check();
    const seconds = mix[0].length / 44100;
    set('separating', `Starting · ${fmtTime(seconds)} of audio`, -1);

    let t0 = 0;
    let stage = '';
    const stems = await engine.separate(
      { id: t.id, mix, model: s.model, precision: s.precision, device: s.device, shifts: s.shifts, overlap: s.overlap, twoStems: s.twoStems, skip: s.skipStems },
      (p) => {
        if (p.done < 0) return set('separating', `${p.stage}…`, -1);
        if (p.stage !== stage || !t0) [stage, t0] = [p.stage, performance.now()];
        const eta = p.done > 1 ? ((performance.now() - t0) / 1000 / p.done) * (p.total - p.done) : NaN;
        set('separating', [`${Math.round((100 * p.done) / p.total)}%`, fmtEta(eta)].filter(Boolean).join(' · '), p.done / p.total);
      },
    );
    t.result = { title: t.file.name, stems, settings: s, seconds };
    set('done', `Done · ${MODELS[s.model].label}${s.twoStems ? ` · ${s.twoStems} / rest` : ''}`, 1);
    if (!deck.current) openTrack(t);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'Cancelled' || t.status === 'cancelled') {
      t.status = 'cancelled';
      t.text = 'Cancelled';
    } else {
      t.status = 'error';
      t.text = friendlyError(err);
      toast(`${t.file.name}: ${t.text}`, true);
    }
    renderTrack(t);
  }
}

function friendlyError(e: Error) {
  const m = e.message || String(e);
  if (/decode|EncodingError|Unable to decode/i.test(m) || e.name === 'EncodingError') return "Couldn't read this audio format";
  if (/memory|allocation|OOM|RangeError/i.test(m)) return 'Ran out of memory. Try a shorter file, the Compact model, or CPU.';
  if (/Could not find an implementation/i.test(m))
    return 'This model file uses maths the browser engine lacks (float64). Convert it with tools/fix_models.py and import it via Models (see README).';
  if (/Failed to fetch|NetworkError|Download failed/i.test(m)) return 'Model download failed. Check your connection, or import it via Models.';
  return m;
}

// ---------------------------------------------------------------- file input & drag/drop
const input = $<HTMLInputElement>('fileInput');
input.onchange = () => {
  addFiles(input.files ?? []);
  input.value = '';
};
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer?.types.includes('Files')) document.body.classList.toggle('dragging', ++dragDepth > 0);
});
window.addEventListener('dragleave', () => document.body.classList.toggle('dragging', --dragDepth > 0));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});
refreshQueue();

// ---------------------------------------------------------------- PWA bits
let installEvt: any = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('installBtn').hidden = false;
});
$('installBtn').onclick = async () => {
  await installEvt?.prompt();
  installEvt = null;
  $('installBtn').hidden = true;
};

window.addEventListener('beforeunload', (e) => {
  if (tracks.some((t) => ['downloading', 'decoding', 'separating'].includes(t.status))) e.preventDefault();
});

function registerServiceWorker() {
  if (isTauri || !('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  navigator.serviceWorker.register('./sw.js').then(() => {
    // The service worker adds the headers that enable multi-threaded WASM.
    // It only takes effect after a reload, so do that once.
    if (!crossOriginIsolated && !sessionStorageGet('coi-reloaded')) {
      const reload = () => {
        sessionStorageSet('coi-reloaded', '1');
        location.reload();
      };
      if (navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    }
  });
}
function sessionStorageGet(k: string) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return '1';
  }
}
function sessionStorageSet(k: string, v: string) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

// Opened via "Open with Stemdeck" on an installed PWA.
(window as any).launchQueue?.setConsumer(async (p: { files: FileSystemFileHandle[] }) => {
  if (p.files?.length) addFiles(await Promise.all(p.files.map((f) => f.getFile())));
});
