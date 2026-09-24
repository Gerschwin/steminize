import { ALL_FILES, MODELS, type ModelFile } from '../models.ts';
import { deleteModel, downloadModel, hasModel, importModel } from '../modelstore.ts';
import { $, fmtMB, h, toast } from './dom.ts';

type Listener = (key: string, loaded: number, total: number) => void;
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<Listener>();
export const onModelsChanged = new Set<() => void>();
const changed = () => onModelsChanged.forEach((f) => f());

function fetchOnce(f: ModelFile) {
  let p = inflight.get(f.key);
  if (!p) {
    p = downloadModel(f, (l, t) => listeners.forEach((fn) => fn(f.key, l, t))).finally(() => {
      inflight.delete(f.key);
      changed();
    });
    inflight.set(f.key, p);
  }
  return p;
}

/** Make sure every file is available locally, reporting combined progress. */
export async function ensureDownloaded(files: ModelFile[], onProgress: (frac: number, label: string) => void) {
  const missing: ModelFile[] = [];
  for (const f of files) if (!(await hasModel(f))) missing.push(f);
  if (!missing.length) return;
  const total = missing.reduce((a, f) => a + f.bytes, 0);
  const got = new Map<string, number>();
  const fn: Listener = (key, loaded) => {
    if (!missing.some((f) => f.key === key)) return;
    got.set(key, loaded);
    const sum = [...got.values()].reduce((a, b) => a + b, 0);
    onProgress(Math.min(1, sum / total), `Downloading model ${fmtMB(sum)} / ${fmtMB(total)}`);
  };
  listeners.add(fn);
  try {
    for (const f of missing) await fetchOnce(f); // one at a time: kinder to slow connections
  } finally {
    listeners.delete(fn);
  }
}

export function initModelsDialog() {
  const dlg = $<HTMLDialogElement>('modelsDlg');
  const list = $('modelList');

  async function render() {
    const groups = await Promise.all(
      Object.values(MODELS).map(async (m) => {
        const rows = await Promise.all(
          (['compact', 'full'] as const).flatMap((p) =>
            m.files[p].map(async (f) => {
              const have = await hasModel(f);
              const busy = inflight.has(f.key);
              const st = h('span', { class: `st${have ? ' have' : ''}` }, busy ? 'Downloading…' : have ? 'Downloaded' : fmtMB(f.bytes));
              const btn = h('button', { class: 'btn tiny ghost', type: 'button' }, have ? 'Delete' : 'Download');
              btn.disabled = busy;
              btn.onclick = async () => {
                if (have) {
                  await deleteModel(f);
                  changed();
                } else {
                  const stop = watch(f, st);
                  fetchOnce(f)
                    .catch((e) => toast(`Download failed: ${e.message}`, true))
                    .finally(stop);
                }
                render();
              };
              return h('div', { class: 'm-file' }, h('code', { title: f.url }, f.key), st, btn);
            }),
          ),
        );
        return h('div', { class: 'm-group' }, h('h3', {}, m.label), ...rows);
      }),
    );
    list.replaceChildren(...groups);
    const est = await navigator.storage?.estimate?.();
    $('storageInfo').textContent = est?.usage != null ? `Using ${fmtMB(est.usage)} of storage` : '';
  }

  function watch(f: ModelFile, st: HTMLElement) {
    const fn: Listener = (key, l, t) => {
      if (key === f.key) st.textContent = `${Math.round((100 * l) / t)}%`;
    };
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  $('modelsBtn').onclick = () => {
    render();
    dlg.showModal();
  };
  $<HTMLInputElement>('importModel').onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    for (const file of input.files ?? []) {
      const f = ALL_FILES.find((x) => x.key === file.name);
      if (!f) {
        toast(`${file.name}: unknown file name. Expected one of the names listed above.`, true);
        continue;
      }
      try {
        await importModel(f, file);
        toast(`Imported ${file.name}`);
      } catch (err) {
        toast((err as Error).message, true);
      }
    }
    input.value = '';
    changed();
    render();
  };
}
