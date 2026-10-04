// Experimental "Native audio" test panel (desktop app only): talks to the Rust side (src-tauri/src/native_audio.rs),
// which opens the sound card directly instead of going through the webview. It is a measuring tool for now:
// monitor the input by ear, or measure the round trip with the output patched to an input.
import { isTauri } from '../platform.ts';
import { toast } from './dom.ts';
import type { Player } from '../player/player.ts';

interface DeviceInfo {
  host: string;
  kind: 'input' | 'output';
  name: string;
  channels: number;
  sample_rate: number;
  buffer_min: number | null;
  buffer_max: number | null;
  is_default: boolean;
}

interface MonitorStats {
  queue_ms: number;
  underruns: number;
  trims: number;
}

interface LoopbackResult {
  ms: number | null;
  hits: number;
  total: number;
  detail: string;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const KEY = 'steminize.nativePlayback';
interface Saved {
  on: boolean;
  host: string;
  output: string;
  buffer: number;
  rate: number;
}

const loadSaved = (): Saved | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};

export function initNativeAudio(player: Player) {
  const box = document.getElementById('nativeAudioBox');
  if (!isTauri || !box) return;
  box.hidden = false;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const hostSel = $<HTMLSelectElement>('naHost');
  const inSel = $<HTMLSelectElement>('naInput');
  const outSel = $<HTMLSelectElement>('naOutput');
  const chanSel = $<HTMLSelectElement>('naChannel');
  const bufSel = $<HTMLSelectElement>('naBuffer');
  const rateSel = $<HTMLSelectElement>('naRate');
  const monBtn = $<HTMLButtonElement>('naMonitor');
  const loopBtn = $<HTMLButtonElement>('naLoopback');
  const status = $('naStatus');
  const playbackBox = $<HTMLInputElement>('naPlayback');
  player.onNativeError = (m) => toast(m, true);
  let devices: DeviceInfo[] = [];
  let invoke: Invoke | null = null;
  let monitoring = false;
  let lastRoundTrip: number | null = null;
  let statsTimer = 0;
  let monitorSummary = '';

  const call = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    invoke ??= (await import('@tauri-apps/api/core')).invoke as Invoke;
    return invoke<T>(cmd, args);
  };

  const fillDevices = () => {
    const host = hostSel.value;
    const opts = (kind: 'input' | 'output') =>
      devices
        .filter((d) => d.host === host && d.kind === kind)
        .map((d) => {
          const o = document.createElement('option');
          o.value = d.name;
          o.textContent = `${d.name}${d.is_default ? ' (default)' : ''} — ${d.channels} ch, ${d.sample_rate} Hz`;
          return o;
        });
    inSel.replaceChildren(...opts('input'));
    outSel.replaceChildren(...opts('output'));
    // Start on something sensible: the host's default device, else the PipeWire / PulseAudio / "default" ones, not the first in the list.
    for (const [sel, kind] of [[inSel, 'input'], [outSel, 'output']] as const) {
      const pick = devices.find((d) => d.host === host && d.kind === kind && d.is_default) ?? ['pipewire', 'pulse', 'default'].map((n) => devices.find((d) => d.host === host && d.kind === kind && d.name === n)).find(Boolean);
      if (pick) sel.value = pick.name;
    }
  };

  const load = async () => {
    try {
      devices = await call<DeviceInfo[]>('native_audio_devices');
      const hosts = [...new Set(devices.map((d) => d.host))];
      hostSel.replaceChildren(
        ...hosts.map((h) => {
          const o = document.createElement('option');
          o.value = h;
          o.textContent = h;
          return o;
        }),
      );
      fillDevices();
      status.textContent = devices.length ? `${devices.length} devices found.` : 'No native audio devices found.';
    } catch (e) {
      status.textContent = `Couldn't list devices: ${(e as Error).message ?? e}`;
    }
  };

  const args = () => ({
    host: hostSel.value,
    input: inSel.value,
    output: outSel.value,
    inChannel: Number(chanSel.value),
    buffer: Number(bufSel.value) || 0,
    fixed: Number(bufSel.value) > 0,
    rate: Number(rateSel.value),
  });

  /** While monitoring: the buffering the loopback test measured plus the queue between the input and output callbacks. */
  const showStats = async () => {
    try {
      const st = await call<MonitorStats>('native_monitor_stats');
      const est = lastRoundTrip == null ? '' : ` Estimated delay you hear: ${(lastRoundTrip + st.queue_ms).toFixed(1)} ms (${lastRoundTrip} round trip + ${st.queue_ms} queue).`;
      status.textContent = `Monitoring natively: ${monitorSummary}. Queue ${st.queue_ms} ms, ${st.underruns} dropouts.${est}`;
    } catch {
      /* stopped meanwhile */
    }
  };

  hostSel.onchange = fillDevices;
  $('naRefresh').onclick = () => void load();

  monBtn.onclick = async () => {
    monBtn.disabled = true;
    try {
      if (monitoring) {
        await call('native_monitor_stop');
        monitoring = false;
        monBtn.textContent = 'Native monitor';
        clearInterval(statsTimer);
        status.textContent = 'Stopped.';
      } else {
        status.textContent = 'Starting…';
        const summary = await call<string>('native_monitor_start', { ...args(), gain: 1 });
        monitoring = true;
        monitorSummary = summary;
        monBtn.textContent = 'Stop native monitor';
        status.textContent = `Monitoring natively: ${summary}`;
        clearInterval(statsTimer);
        statsTimer = window.setInterval(() => void showStats(), 1000);
      }
    } catch (e) {
      status.textContent = `Couldn't ${monitoring ? 'stop' : 'start'}: ${e}`;
      toast(`Native audio: ${e}`, true);
    } finally {
      monBtn.disabled = false;
    }
  };

  loopBtn.onclick = async () => {
    if (monitoring) {
      await call('native_monitor_stop');
      monitoring = false;
      clearInterval(statsTimer);
      monBtn.textContent = 'Native monitor';
    }
    loopBtn.disabled = monBtn.disabled = true;
    status.textContent = 'Measuring… clicks will play out of the chosen output for about 5 seconds.';
    try {
      const r = await call<LoopbackResult>('native_loopback', args());
      lastRoundTrip = r.ms;
      status.textContent =
        r.ms == null
          ? `Couldn't hear the clicks (${r.hits}/${r.total}). Patch the output to the chosen input with a cable, or hold the mic to the speaker. ${r.detail}`
          : `Round trip ${r.ms} ms (${r.hits} of ${r.total} clicks). ${r.detail}`;
    } catch (e) {
      status.textContent = `Couldn't measure: ${e}`;
    } finally {
      loopBtn.disabled = monBtn.disabled = false;
    }
  };

  const saved = loadSaved();

  const startPlayback = async (): Promise<boolean> => {
    const a = args();
    try {
      const summary = await player.startNative({ host: a.host, output: a.output, buffer: a.buffer, fixed: a.fixed, rate: a.rate });
      status.textContent = `Native playback on: ${summary}. Reopen the song to play it natively.`;
      try {
        localStorage.setItem(KEY, JSON.stringify({ on: true, host: a.host, output: a.output, buffer: a.buffer, rate: a.rate } satisfies Saved));
      } catch {
        /* ignore */
      }
      return true;
    } catch (e) {
      status.textContent = `Couldn't start native playback: ${e}`;
      return false;
    }
  };

  playbackBox.onchange = async () => {
    if (playbackBox.checked) {
      playbackBox.checked = await startPlayback();
    } else {
      await player.stopNative().catch(() => {});
      try {
        const s = loadSaved();
        if (s) localStorage.setItem(KEY, JSON.stringify({ ...s, on: false }));
      } catch {
        /* ignore */
      }
      status.textContent = 'Native playback off.';
    }
  };

  // Reopen the last choice: pick the saved devices and, if native playback was on, switch it on again.
  void load().then(async () => {
    if (!saved) return;
    if ([...hostSel.options].some((o) => o.value === saved.host)) {
      hostSel.value = saved.host;
      fillDevices();
    }
    if ([...outSel.options].some((o) => o.value === saved.output)) outSel.value = saved.output;
    bufSel.value = String(saved.buffer);
    rateSel.value = String(saved.rate);
    if (saved.on) playbackBox.checked = await startPlayback();
  });
}
