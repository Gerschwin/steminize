// "Copy diagnostic info": a plain-text summary of the setup and recent errors to paste into a bug
// report. It never includes file names, song titles or anything from the library, and nothing is sent
// anywhere: it is only ever copied to the clipboard when the user asks.
import { ALL_FILES } from '../models.ts';
import { hasModel } from '../modelstore.ts';
import { isTauri } from '../platform.ts';
import { loadRecLatencyMs, loadSettings } from '../settings.ts';

let backend: { backend: string; threads: number; note?: string } | null = null;
const errors: string[] = [];

/** What the separation engine last reported (called from main.ts). */
export function setBackendInfo(b: { backend: string; threads: number; note?: string }) {
  backend = b;
}

/** Keeps the last few uncaught errors (message only) so they can be included. */
export function installErrorLog() {
  const add = (msg: string) => {
    errors.push(`${new Date().toISOString().slice(11, 19)} ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (errors.length > 10) errors.shift();
  };
  window.addEventListener('error', (e) => add(e.message || 'error'));
  window.addEventListener('unhandledrejection', (e) => add(`unhandled: ${(e.reason as Error)?.message ?? String(e.reason)}`));
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export async function collectDiagnostics(): Promise<string> {
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: { requestAdapter(): Promise<unknown> } };
  const lines: string[] = [];
  const add = (k: string, v: unknown) => lines.push(`${k.padEnd(18)} ${v}`);

  add('Steminize', `v${__APP_VERSION__} (${isTauri ? 'desktop app' : 'web app'}), built ${__BUILD_DATE__}`);
  add('Collected', new Date().toISOString());
  add('Browser', nav.userAgent);
  add('Platform', `${nav.platform || 'n/a'}, ${nav.language}`);
  add('Window', `${innerWidth}x${innerHeight} at ${devicePixelRatio}x`);
  add('CPU threads', nav.hardwareConcurrency || 'n/a');
  add('Device memory', nav.deviceMemory ? `${nav.deviceMemory} GB (browser estimate, capped)` : 'not reported');
  add('Isolated', `crossOriginIsolated=${self.crossOriginIsolated}, SharedArrayBuffer=${typeof SharedArrayBuffer}`);
  let gpu = 'not available';
  try {
    if (nav.gpu) gpu = (await nav.gpu.requestAdapter()) ? 'available' : 'API present, no adapter';
  } catch (e) {
    gpu = `error: ${(e as Error).message}`;
  }
  add('WebGPU', gpu);
  add('Separation ran on', backend ? `${backend.backend}, ${backend.threads} thread(s)${backend.note ? ` (${backend.note})` : ''}` : 'nothing run yet this session');

  const s = loadSettings();
  add('Settings', `model=${s.model}, precision=${s.precision}, device=${s.device}, shifts=${s.shifts}, overlap=${s.overlap}`);
  const have: string[] = [];
  for (const f of ALL_FILES) if (await hasModel(f).catch(() => false)) have.push(f.key);
  add('Models on device', have.length ? have.join(', ') : 'none');
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) add('Storage', `${gb(est.usage ?? 0)} used of ${gb(est.quota)}`);
  } catch {
    /* not available */
  }

  try {
    const ctx = new AudioContext();
    add('Audio output', `${ctx.sampleRate} Hz, base latency ${Math.round(ctx.baseLatency * 1000)} ms, output latency ${'outputLatency' in ctx ? Math.round(ctx.outputLatency * 1000) + ' ms' : 'not reported'}`);
    await ctx.close();
  } catch (e) {
    add('Audio output', `error: ${(e as Error).message}`);
  }
  try {
    const inputs = (await navigator.mediaDevices?.enumerateDevices?.())?.filter((d) => d.kind === 'audioinput').length;
    add('Audio inputs', inputs ?? 'not available');
  } catch {
    add('Audio inputs', 'not available');
  }
  add('Recording latency', `${loadRecLatencyMs()} ms`);

  lines.push('', 'Recent errors:');
  lines.push(...(errors.length ? errors.map((e) => `  ${e}`) : ['  none']));
  return lines.join('\n');
}
