import './styles.css';
import { Engine } from './engine/client.ts';
import type { Stereo } from './engine/separate.ts';
import { MODELS, neededFiles } from './models.ts';
import { isTauri, pickFolderFiles } from './platform.ts';
import { loadSettings, type Settings } from './settings.ts';
import { Deck, type Result } from './ui/deck.ts';
import { $, fmtDuration, fmtEta, fmtTime, h, openDialog, toast } from './ui/dom.ts';
import { ensureDownloaded, initModelsDialog, onModelsChanged } from './ui/modelsDialog.ts';
import { SettingsPanel } from './ui/settingsPanel.ts';
import { initLibrary } from './ui/libraryPanel.ts';
import { initSetlists } from './ui/setlistPanel.ts';
import { initYoutubeDialog } from './ui/youtubeDialog.ts';
import { songSizeWarning } from './engine/sizeHint.ts';
import { initTheme } from './theme.ts';
import { initAbout } from './ui/about.ts';
import { installErrorLog, setBackendInfo } from './ui/diagnostics.ts';

// ---------------------------------------------------------------- setup
installErrorLog();
registerServiceWorker();
// The webview's own right-click menu ("Reload", "Inspect Element", ...) looks out of place on the
// app's own UI chrome — suppressed there, but left alone on text fields, where cut/copy/paste and
// spellcheck suggestions are genuinely useful. Same target check as the keyboard-shortcut guard in
// deck.ts's initKeys().
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  const editable = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t as HTMLElement)?.isContentEditable;
  if (!editable) e.preventDefault();
});
initTheme($<HTMLButtonElement>('themeBtn'), $<HTMLMetaElement>('themeColorMeta'));
const settings = new SettingsPanel(loadSettings());
const deck = new Deck(() => settings.s);
const library = initLibrary(deck);
library.onOpen = () => refreshQueue();
initSetlists(deck, library);
const engine = new Engine();
initModelsDialog();
initAbout();
onModelsChanged.add(() => settings.render());
$('helpBtn').onclick = () => openDialog($<HTMLDialogElement>('helpDlg'));

const chip = $('backendChip');
chip.textContent = 'Checking device…';
// WebGPU support in WebKitGTK (the Linux desktop app's webview) is experimental and was the direct
// cause of a severe OOM crash earlier (an asyncify WASM build misbehaving) — avoided by not loading
// that build unless a GPU is actually usable, but the underlying WebKitGTK issue isn't something
// this app can truly fix, just avoid triggering where possible. On a Linux system where a GPU *is*
// detected as usable, that risk is still live, so flag it upfront rather than let it be a surprise.
const gpuLinuxNote = $('gpuLinuxNote');
const linuxDesktop = isTauri && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
const showGpuNote = (on: boolean) => (gpuLinuxNote.hidden = !(linuxDesktop && on));
gpuLinuxNote.onclick = () => {
  toast('WebGPU on Linux is experimental and has caused crashes in this app before. If you run into instability, switch "Run on" to CPU in Settings.', false, 8000);
  document.querySelector<HTMLButtonElement>('.stab[data-side="settings"]')?.click();
};
// Chrome can expose WebGPU without a usable GPU, so ask for an actual adapter.
(async () => {
  let gpu = false;
  try {
    gpu = !!(await (navigator as any).gpu?.requestAdapter());
  } catch {
    /* no GPU */
  }
  if (chip.textContent === 'Checking device…') {
    chip.textContent = gpu ? 'GPU ready' : `CPU only · ${navigator.hardwareConcurrency || '?'} threads`;
    chip.title = gpu ? 'Separation will use your graphics card' : 'No usable GPU found; separation will run on the processor (slower)';
    chip.className = `chip${gpu ? ' gpu' : ''}`;
    showGpuNote(gpu);
  }
})();
const GPU_FAILED_KEY = 'steminize.gpuFailed';
/** The GPU didn't work for a previous song (see worker.ts): with Device on Auto, start on the CPU instead of waiting for it to fail again. */
const gpuFailedBefore = () => {
  try {
    return localStorage.getItem(GPU_FAILED_KEY) === '1';
  } catch {
    return false;
  }
};

engine.onBackend = ({ backend, threads, note }) => {
  if (note?.startsWith('GPU failed')) {
    try {
      localStorage.setItem(GPU_FAILED_KEY, '1');
    } catch {
      /* ignore */
    }
    toast('The GPU did not work, so Steminize is using the CPU. Set Device to GPU in Settings to try it again.', true, 9000);
  }
  setBackendInfo({ backend, threads, note });
  chip.textContent = backend === 'webgpu' ? 'Running on GPU' : `Running on CPU · ${threads} thread${threads > 1 ? 's' : ''}`;
  chip.className = `chip${backend === 'webgpu' ? ' gpu' : ''}`;
  showGpuNote(backend === 'webgpu');
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
  started?: number; // performance.now() when separation began
  settings: Settings; // locked when the song is added
  result?: Result;
  el: HTMLLIElement;
}
const tracks: Track[] = [];
let busy = false;
/** Whether the queue may start the next song. */
let running = false;
/** Stop after the song that is currently processing. */
let pauseAfter = false;

const pref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const autoStart = $<HTMLInputElement>('autoStart');
autoStart.checked = pref('steminize.autoStart', '1') === '1';
autoStart.onchange = () => {
  try {
    localStorage.setItem('steminize.autoStart', autoStart.checked ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (autoStart.checked) {
    running = true;
    void pump();
  }
  refreshQueue();
};

/** Short description of the settings a song will be separated with. */
function summary(s: Settings) {
  const stems = s.twoStems ? `${s.twoStems}/rest` : s.skipStems.length ? `${MODELS[s.model].stems.filter((x) => !s.skipStems.includes(x)).join('+')}` : 'all stems';
  const short = { htdemucs: 'HT Demucs', htdemucs_ft: 'Fine-tuned', htdemucs_6s: '6-stem' }[s.model];
  return [short, stems, s.shifts > 1 ? `${s.shifts} shifts` : '', s.precision === 'full' ? 'fp32' : '']
    .filter(Boolean)
    .join(' · ');
}
const sameSettings = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);

function addFiles(files: Iterable<File>) {
  let added = 0;
  for (const file of files) {
    if (!/^audio\/|^video\//.test(file.type) && !/\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?|webm|mp4)$/i.test(file.name)) continue;
    const t: Track = { id: crypto.randomUUID(), file, status: 'queued', text: 'Waiting', frac: 0, settings: structuredClone(settings.s), el: h('li') };
    tracks.push(t);
    $('queue').append(t.el);
    renderTrack(t);
    added++;
  }
  if (!added) toast('No audio files found in that selection.', true);
  if (added && autoStart.checked) running = true;
  if (added) showSide('songs');
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
  t.el.replaceChildren(
    h('div', { class: 't-name', title: t.file.name }, t.file.name),
    x,
    h('div', { class: 't-sub' }, subText(t)),
    t.status === 'done' ? '' : h('div', { class: 't-set' }, summary(t.settings)),
    running || t.status === 'queued' ? bar : '',
  );
  t.el.onclick = () => t.result && openTrack(t);
}

const isRunning = (t: Track) => ['downloading', 'decoding', 'separating'].includes(t.status);
function subText(t: Track) {
  const elapsed = isRunning(t) && t.started ? ` · ${fmtDuration((performance.now() - t.started) / 1000)} elapsed` : '';
  return t.text + elapsed;
}

function refreshQueue() {
  $('queueEmpty').hidden = tracks.length > 0;
  $('queueCard').hidden = tracks.length === 0;
  const waiting = tracks.filter((t) => t.status === 'queued');
  const btn = $<HTMLButtonElement>('queueBtn');
  if (busy) {
    btn.textContent = pauseAfter ? 'Will stop after this song (undo)' : 'Pause after this song';
    btn.classList.toggle('primary', false);
    btn.hidden = !waiting.length && !pauseAfter;
  } else {
    btn.hidden = !waiting.length;
    btn.textContent = `Start${waiting.length > 1 ? ` (${waiting.length} songs)` : ''}`;
    btn.classList.toggle('primary', true);
  }
  $('applyWaiting').hidden = !waiting.some((t) => !sameSettings(t.settings, settings.s));
  $('clearDone').hidden = !tracks.some((t) => ['done', 'error', 'cancelled'].includes(t.status));
  tracks.forEach(renderTrack);
}

function openTrack(t: Track) {
  deck.open(t.result!, library.stateFor(t.result!));
  refreshQueue();
  library.refresh();
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

$('queueBtn').onclick = () => {
  if (busy) pauseAfter = !pauseAfter;
  else {
    running = true;
    void pump();
  }
  refreshQueue();
};
$('applyWaiting').onclick = () => {
  for (const t of tracks) if (t.status === 'queued') t.settings = structuredClone(settings.s);
  refreshQueue();
  toast('Waiting songs will use the current settings');
};
settings.onChange = () => {
  refreshQueue();
  updateUseSummary();
};

// ---------------------------------------------------------------- sidebar tabs
function showSide(name: string) {
  for (const t of document.querySelectorAll<HTMLElement>('.stab')) t.setAttribute('aria-selected', String(t.dataset.side === name));
  for (const p of document.querySelectorAll<HTMLElement>('.side-pane')) p.hidden = p.dataset.sidepane !== name;
}
for (const t of document.querySelectorAll<HTMLElement>('.stab')) t.onclick = () => showSide(t.dataset.side!);
$('changeSettings').onclick = () => showSide('settings');
function updateUseSummary() {
  const s = settings.s;
  $('useSum').textContent = `${summary(s)} · ${s.format.toUpperCase()}`;
}
updateUseSummary();

$('clearDone').onclick = () => {
  for (const t of [...tracks]) if (['done', 'error', 'cancelled'].includes(t.status) && t.result !== deck.current) removeTrack(t);
};

deck.onRerun = () => {
  const t = tracks.find((x) => x.result === deck.current);
  if (!t) return;
  addFiles([t.file]);
  toast(autoStart.checked ? 'Queued again with the current settings' : 'Queued with the current settings. Press Start when ready.');
};

async function pump() {
  if (busy || !running) return;
  if (pauseAfter) {
    pauseAfter = false;
    running = false;
    refreshQueue();
    return;
  }
  const t = tracks.find((x) => x.status === 'queued');
  if (!t) {
    running = autoStart.checked;
    return;
  }
  busy = true;
  refreshQueue();
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
  // On the Linux desktop app, decodeAudioData can hang indefinitely instead of failing
  // when the system's GStreamer install is missing a codec, rather than reject. Time it
  // out so that shows up as an error instead of a stuck "Reading audio…".
  const buf = await Promise.race([
    ctx.decodeAudioData(bytes),
    new Promise<AudioBuffer>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('Timed out reading the audio'), { name: 'DecodeTimeout' })), 20_000),
    ),
  ]);
  const l = buf.getChannelData(0).slice();
  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : l.slice();
  return [l, r];
}

async function processTrack(t: Track) {
  const s: Settings = t.settings;
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
    const heads = songSizeWarning(seconds, MODELS[s.model].stems.length, (navigator as { deviceMemory?: number }).deviceMemory);
    if (heads) toast(heads, false, 12000);
    t.started = performance.now();
    set('separating', `Starting · ${fmtTime(seconds)} of audio`, -1);

    let t0 = 0;
    let stage = '';
    let loadTimer = 0;
    const stems = await engine.separate(
      { id: t.id, mix, model: s.model, precision: s.precision, device: s.device === 'auto' && gpuFailedBefore() ? 'cpu' : s.device, shifts: s.shifts, overlap: s.overlap, twoStems: s.twoStems, skip: s.skipStems },
      (p) => {
        if (p.done < 0) {
          // Loading a model can take a while (the first time especially): count the seconds so it doesn't look stuck.
          clearInterval(loadTimer);
          const began = performance.now();
          const say = () => {
            if (t.status !== 'separating') return clearInterval(loadTimer); // finished, failed or cancelled meanwhile
            set('separating', `${p.stage}… ${Math.round((performance.now() - began) / 1000)} s`, -1);
          };
          say();
          loadTimer = window.setInterval(say, 1000);
          return;
        }
        clearInterval(loadTimer);
        // The model is loaded and the first pass is running: say so, rather than leave "Loading model…" up for it.
        if (p.done === 0) return set('separating', 'Separating…', -1);
        if (p.stage !== stage || !t0) [stage, t0] = [p.stage, performance.now()];
        const eta = p.done > 1 ? ((performance.now() - t0) / 1000 / p.done) * (p.total - p.done) : NaN;
        set('separating', [`${Math.round((100 * p.done) / p.total)}%`, fmtEta(eta)].filter(Boolean).join(' · '), p.done / p.total);
      },
    );
    clearInterval(loadTimer);
    const took = (performance.now() - t.started) / 1000;
    t.started = undefined;
    t.result = { title: t.file.name, stems, settings: s, seconds, took };
    set('done', `Done in ${fmtDuration(took)} (${(took / seconds).toFixed(1)}× song length) · ${MODELS[s.model].label}${s.twoStems ? ` · ${s.twoStems} / rest` : ''}`, 1);
    if (!deck.current) openTrack(t);
    void library.afterSeparation(t.result);
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
  if (e.name === 'DecodeTimeout')
    return isTauri
      ? 'Reading the audio timed out. This desktop app needs GStreamer for audio decoding; try installing gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad and gstreamer1.0-libav (or your distro’s equivalents).'
      : 'Reading the audio timed out.';
  if (/decode|EncodingError|Unable to decode/i.test(m) || e.name === 'EncodingError') return "Couldn't read this audio format";
  if (/memory|allocation|OOM|RangeError/i.test(m)) return 'Ran out of memory. Try a shorter file, the Compact model, or CPU.';
  if (/Could not find an implementation/i.test(m))
    return `The browser engine can't run part of this model: ${m.replace(/^.*ERROR_MESSAGE:\s*/, '').slice(0, 160)}`;
  if (/Failed to fetch|NetworkError|Download failed/i.test(m)) return 'Model download failed. Check your connection, or import it via Models.';
  return m;
}

// ---------------------------------------------------------------- open multitrack (no separation)
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?|webm)$/i;

/** Strip a shared prefix like "My Song - " so lanes are just "Bass", "Drums"… */
function trackNames(files: File[]) {
  const base = files.map((f) => f.name.replace(/\.[^.]+$/, ''));
  if (base.length < 2) return { names: base, prefix: '' };
  let prefix = base[0];
  for (const b of base) while (prefix && !b.startsWith(prefix)) prefix = prefix.slice(0, -1);
  // Only cut at a separator, so "Bass" and "Bassoon" don't lose "Bass".
  prefix = prefix.match(/^(.*[\s_\-–.])/)?.[1] ?? '';
  return { names: base.map((b) => b.slice(prefix.length).trim() || b), prefix: prefix.replace(/[\s_\-–.]+$/, '') };
}

async function openMultitrack(list: FileList | File[]) {
  const files = [...list].filter((f) => AUDIO_EXT.test(f.name) || f.type.startsWith('audio/')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) {
    toast('No audio files found there.', true);
    return;
  }
  const folder = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0];
  const { names, prefix } = trackNames(files);
  const note = toast(`Loading ${files.length} track${files.length > 1 ? 's' : ''}…`, false, 600_000);
  try {
    const decoded: Stereo[] = [];
    for (const [i, f] of files.entries()) {
      note.textContent = `Loading track ${i + 1} of ${files.length}: ${f.name}`;
      decoded.push(await decode(f));
    }
    // Everything starts at 0; shorter tracks are padded with silence to the longest.
    const len = Math.max(...decoded.map((d) => d[0].length));
    const stems = decoded.map((d, i) => {
      const pad = (c: Float32Array) => {
        if (c.length === len) return c;
        const o = new Float32Array(len);
        o.set(c);
        return o;
      };
      return { name: names[i], data: [pad(d[0]), pad(d[1])] as Stereo };
    });
    const lengths = decoded.map((d) => d[0].length);
    const r: Result = {
      title: folder || prefix || (files.length === 1 ? files[0].name : `Multitrack (${files.length} tracks)`),
      stems,
      settings: structuredClone(settings.s),
      seconds: len / 44100,
      kind: 'multitrack',
    };
    deck.open(r);
    refreshQueue();
    if (Math.max(...lengths) - Math.min(...lengths) > 44100 * 2)
      toast('Tracks have different lengths. They are lined up from the start, so export every part from the same point (e.g. bar 1).', false, 9000);
    void library.afterSeparation(r);
  } catch (e) {
    toast(`Couldn't open those files: ${friendlyError(e as Error)}`, true);
  } finally {
    note.remove();
  }
}
for (const id of ['multiFiles', 'multiFolder']) {
  const el = $<HTMLInputElement>(id);
  el.onchange = () => {
    if (el.files?.length) void openMultitrack(el.files);
    el.value = '';
  };
}
// WebKitGTK (the Linux desktop app's webview) doesn't support the HTML `webkitdirectory`
// picker, so it silently falls back to picking a single file. Use Tauri's native folder
// dialog instead there.
if (isTauri) {
  $('multiFolderLabel').onclick = (e) => {
    e.preventDefault();
    void pickFolderFiles().then((files) => {
      if (files?.length) void openMultitrack(files);
    });
  };
  // Downloading needs yt-dlp shelled out from the native side; there's no browser-only
  // equivalent, so this stays desktop-only.
  const yt = initYoutubeDialog((file) => addFiles([file]));
  const ytBtn = $('ytBtn');
  ytBtn.hidden = false;
  ytBtn.onclick = () => yt.open();
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

// Tick the "elapsed" time on running tracks once a second.
setInterval(() => {
  // Only touch the text, so a click on the cancel button isn't lost to a re-render.
  for (const t of tracks) if (t.started && isRunning(t)) t.el.querySelector('.t-sub')!.textContent = subText(t);
}, 1000);

$('appVersion').textContent = `v${__APP_VERSION__}`;
$('appVersion').title = `Steminize ${__APP_VERSION__}, built ${__BUILD_DATE__}`;

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

// Opened via "Open with Steminize" on an installed PWA.
(window as any).launchQueue?.setConsumer(async (p: { files: FileSystemFileHandle[] }) => {
  if (p.files?.length) addFiles(await Promise.all(p.files.map((f) => f.getFile())));
});
