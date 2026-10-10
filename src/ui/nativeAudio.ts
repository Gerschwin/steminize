// Experimental "Native audio" test panel (desktop app only): talks to the Rust side (src-tauri/src/native_audio.rs),
// which opens the sound card directly instead of going through the webview. It is a measuring tool for now:
// monitor the input by ear, or measure the round trip with the output patched to an input.
import { isTauri } from '../platform.ts';
import { toast } from './dom.ts';
import { saveRecLatencyMs } from '../settings.ts';
import type { Player } from '../player/player.ts';
import { createDropdown } from './dropdown.ts';

interface DeviceInfo {
  host: string;
  kind: 'input' | 'output';
  name: string;
  channels: number;
  sample_rate: number;
  buffer_min: number | null;
  buffer_max: number | null;
  is_default: boolean;
  note: string;
  recommended: boolean;
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
  const inSel = createDropdown();
  const outSel = createDropdown();
  $('naInputMount').replaceWith(inSel.el);
  $('naOutputMount').replaceWith(outSel.el);
  inSel.el.classList.add('na-dd');
  outSel.el.classList.add('na-dd');
  inSel.el.title = 'Input device';
  outSel.el.title = 'Output device';
  const route = $('naRoute');
  const stats = $('naStats');
  let audioStatsTimer = 0;
  const chanSel = $<HTMLSelectElement>('naChannel');
  const bufSel = $<HTMLSelectElement>('naBuffer');
  const rateSel = $<HTMLSelectElement>('naRate');
  const monBtn = $<HTMLButtonElement>('naMonitor');
  const loopBtn = $<HTMLButtonElement>('naLoopback');
  const status = $('naStatus');
  const playbackBox = $<HTMLInputElement>('naPlayback');
  player.onNativeError = (m) => toast(m, true);
  player.onNativeNote = (m) => toast(m, false, 7000);
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

  /** One line under the row saying what the chosen devices really are and where they go. */
  const showRoute = () => {
    const line = (kind: 'input' | 'output', name: string) => {
      const d = devices.find((x) => x.host === hostSel.value && x.kind === kind && x.name === name);
      return d ? `${kind === 'input' ? 'Input' : 'Output'}: ${d.name}${d.note ? ` → ${d.note}` : ''}, ${d.channels} ch, ${d.sample_rate} Hz` : '';
    };
    route.textContent = [line('input', inSel.value), line('output', outSel.value)].filter(Boolean).join('  ·  ');
    syncCfg();
  };
  inSel.onChange = showRoute;
  outSel.onChange = showRoute;

  const fillDevices = () => {
    const host = hostSel.value;
    for (const [dd, kind] of [[inSel, 'input'], [outSel, 'output']] as const) {
      const list = devices.filter((d) => d.host === host && d.kind === kind);
      dd.setOptions(list.map((d) => ({ value: d.name, label: `${d.name}${d.recommended ? ' (recommended)' : ''}` })));
      // Start on the recommended device (the direct PipeWire one when PipeWire is running), not the first in the list.
      const pick = list.find((d) => d.recommended) ?? list.find((d) => d.is_default);
      if (pick) dd.value = pick.name;
    }
    showRoute();
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

  /** Tells the player which devices the native live input and the loopback test should use. */
  const syncCfg = () => {
    const a = args();
    player.nativeCfg = { host: a.host, input: a.input, output: a.output, channel: a.inChannel, buffer: a.buffer, fixed: a.fixed, rate: a.rate };
  };
  for (const el of [hostSel, chanSel, bufSel, rateSel]) el.addEventListener('change', syncCfg);
  inSel.el.addEventListener('click', () => setTimeout(syncCfg, 0));
  outSel.el.addEventListener('click', () => setTimeout(syncCfg, 0));
  hostSel.onchange = () => {
    fillDevices();
    syncCfg();
  };
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
      if (r.ms != null) {
        // The native engine's recordings take this round trip off, so a measurement is the calibration.
        saveRecLatencyMs(r.ms, true);
        const box = document.getElementById('liveLatency') as HTMLInputElement | null;
        if (box && player.monitorIsNative) box.value = String(Math.round(r.ms));
      }
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
      clearInterval(audioStatsTimer);
      audioStatsTimer = window.setInterval(showAudioStats, 1000);
      stats.hidden = false;
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

  // The device went away: the deck has already switched back to the webview engine; reflect that here.
  const lostBefore = player.onNativeLost;
  player.onNativeLost = (message) => {
    playbackBox.checked = false;
    clearInterval(audioStatsTimer);
    stats.hidden = true;
    status.textContent = `Native playback stopped: ${message}`;
    lostBefore(message);
  };

  /** While native playback runs: how busy the audio callback is and whether it has glitched. */
  const showAudioStats = () => {
    const { load, dropouts } = player.nativeStats;
    stats.textContent = `Audio load ${Math.round(load * 100)}%, ${dropouts} dropout${dropouts === 1 ? '' : 's'}`;
    stats.classList.toggle('bad', dropouts > 0 || load > 0.8);
  };

  playbackBox.onchange = async () => {
    if (playbackBox.checked) {
      playbackBox.checked = await startPlayback();
    } else {
      await player.stopNative().catch(() => {});
      clearInterval(audioStatsTimer);
      stats.hidden = true;
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
    if (devices.some((d) => d.host === hostSel.value && d.kind === 'output' && d.name === saved.output)) {
      outSel.value = saved.output;
      showRoute();
    }
    bufSel.value = String(saved.buffer);
    rateSel.value = String(saved.rate);
    if (saved.on) playbackBox.checked = await startPlayback();
  });
}
