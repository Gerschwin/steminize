// Native audio, proof of concept (experimental, desktop only).
//
// The webview can only reach the system's shared audio server through WebKit's own pipeline, which adds a
// lot of buffering (a round trip of ~240 ms measured on Linux with a USB interface). This module talks to
// the sound card directly through `cpal` (ALSA here; ASIO / JACK / Core Audio / WASAPI exclusive are other
// cpal hosts) with a buffer size we choose, to find out how low the delay can go before committing to moving
// the whole playback engine native.
//
// Two commands to find out:
//   - monitor: input -> output pass-through, to feel the delay by ear.
//   - loopback: play clicks out and listen for them on the input (output patched to an input with a cable),
//     reporting the round trip in ms.
//
// Nothing here touches the song player; it is a measuring tool.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Device, FromSample, Host, Sample, SampleFormat, SampleRate, SizedSample, Stream, StreamConfig, SupportedBufferSize};
use serde::Serialize;

// ---------- devices ----------

#[derive(Serialize)]
pub struct DeviceInfo {
    host: String,
    /// "input" or "output"
    kind: &'static str,
    name: String,
    channels: u16,
    sample_rate: u32,
    buffer_min: Option<u32>,
    buffer_max: Option<u32>,
    is_default: bool,
}

fn host_by_name(name: &str) -> Result<Host, String> {
    let id = cpal::available_hosts()
        .into_iter()
        .find(|h| h.name() == name)
        .ok_or_else(|| format!("No audio host called {name}"))?;
    cpal::host_from_id(id).map_err(|e| e.to_string())
}

fn buffer_range(b: &SupportedBufferSize) -> (Option<u32>, Option<u32>) {
    match b {
        SupportedBufferSize::Range { min, max } => (Some(*min), Some(*max)),
        SupportedBufferSize::Unknown => (None, None),
    }
}

#[tauri::command]
pub fn native_audio_devices() -> Result<Vec<DeviceInfo>, String> {
    let mut out = Vec::new();
    for id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(id) else { continue };
        let default_in = host.default_input_device().and_then(|d| d.name().ok());
        let default_out = host.default_output_device().and_then(|d| d.name().ok());
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                let Ok(name) = d.name() else { continue };
                let Ok(cfg) = d.default_input_config() else { continue };
                let (lo, hi) = buffer_range(cfg.buffer_size());
                out.push(DeviceInfo {
                    host: id.name().to_string(),
                    kind: "input",
                    is_default: default_in.as_deref() == Some(name.as_str()),
                    name,
                    channels: cfg.channels(),
                    sample_rate: cfg.sample_rate().0,
                    buffer_min: lo,
                    buffer_max: hi,
                });
            }
        }
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                let Ok(name) = d.name() else { continue };
                let Ok(cfg) = d.default_output_config() else { continue };
                let (lo, hi) = buffer_range(cfg.buffer_size());
                out.push(DeviceInfo {
                    host: id.name().to_string(),
                    kind: "output",
                    is_default: default_out.as_deref() == Some(name.as_str()),
                    name,
                    channels: cfg.channels(),
                    sample_rate: cfg.sample_rate().0,
                    buffer_min: lo,
                    buffer_max: hi,
                });
            }
        }
    }
    Ok(out)
}

fn find_device(host: &Host, name: &str, input: bool) -> Result<Device, String> {
    if name.is_empty() {
        return if input { host.default_input_device() } else { host.default_output_device() }.ok_or_else(|| "No default device".to_string());
    }
    let mut devs = if input { host.input_devices() } else { host.output_devices() }.map_err(|e| e.to_string())?;
    devs.find(|d| d.name().map(|n| n == name).unwrap_or(false)).ok_or_else(|| format!("Device not found: {name}"))
}

// ---------- streams ----------

/// Single-producer single-consumer ring of f32 samples, lock-free so the two audio callbacks never wait on each other.
struct Ring {
    buf: Vec<AtomicU32>,
    mask: usize,
    head: AtomicUsize, // next write
    tail: AtomicUsize, // next read
}

impl Ring {
    fn new(pow2: usize) -> Self {
        Ring { buf: (0..pow2).map(|_| AtomicU32::new(0)).collect(), mask: pow2 - 1, head: AtomicUsize::new(0), tail: AtomicUsize::new(0) }
    }
    fn len(&self) -> usize {
        self.head.load(Ordering::Acquire).wrapping_sub(self.tail.load(Ordering::Acquire))
    }
    fn push(&self, v: f32) {
        let h = self.head.load(Ordering::Relaxed);
        if h.wrapping_sub(self.tail.load(Ordering::Acquire)) > self.mask {
            return; // full: drop the newest rather than block
        }
        self.buf[h & self.mask].store(v.to_bits(), Ordering::Relaxed);
        self.head.store(h.wrapping_add(1), Ordering::Release);
    }
    fn pop(&self) -> Option<f32> {
        let t = self.tail.load(Ordering::Relaxed);
        if t == self.head.load(Ordering::Acquire) {
            return None;
        }
        let v = f32::from_bits(self.buf[t & self.mask].load(Ordering::Relaxed));
        self.tail.store(t.wrapping_add(1), Ordering::Release);
        Some(v)
    }
    fn skip(&self, n: usize) {
        let t = self.tail.load(Ordering::Relaxed);
        self.tail.store(t.wrapping_add(n), Ordering::Release);
    }
}

fn fixed_or_default(range: &SupportedBufferSize, wanted: u32, fixed: bool) -> BufferSize {
    if !fixed {
        return BufferSize::Default;
    }
    match range {
        SupportedBufferSize::Range { min, max } => BufferSize::Fixed(wanted.clamp(*min, *max)),
        SupportedBufferSize::Unknown => BufferSize::Fixed(wanted),
    }
}

fn err_fn(e: cpal::StreamError) {
    eprintln!("native audio stream error: {e}");
}

/// Builds an input stream that hands `sink` the chosen channel as mono f32, whatever the device's sample format.
fn build_in<T>(dev: &Device, cfg: &StreamConfig, in_channel: usize, mut sink: impl FnMut(&[f32]) + Send + 'static) -> Result<Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let ch = cfg.channels as usize;
    let pick = in_channel.min(ch.saturating_sub(1));
    let mut mono: Vec<f32> = Vec::new();
    dev.build_input_stream(
        cfg,
        move |data: &[T], _| {
            mono.clear();
            for frame in data.chunks(ch) {
                mono.push(f32::from_sample(frame[pick]));
            }
            sink(&mono);
        },
        err_fn,
        None,
    )
    .map_err(|e| e.to_string())
}

/// Builds an output stream that asks `source` to fill mono f32 and copies that to every output channel.
fn build_out<T>(dev: &Device, cfg: &StreamConfig, mut source: impl FnMut(&mut [f32]) + Send + 'static) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let ch = cfg.channels as usize;
    let mut mono: Vec<f32> = Vec::new();
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], _| {
            let frames = data.len() / ch;
            mono.resize(frames, 0.0);
            source(&mut mono);
            for (i, frame) in data.chunks_mut(ch).enumerate() {
                let v = T::from_sample(mono[i]);
                for s in frame {
                    *s = v;
                }
            }
        },
        err_fn,
        None,
    )
    .map_err(|e| e.to_string())
}

macro_rules! by_format {
    ($fmt:expr, $f:ident, $($arg:expr),*) => {
        match $fmt {
            SampleFormat::F32 => $f::<f32>($($arg),*),
            SampleFormat::I16 => $f::<i16>($($arg),*),
            SampleFormat::I32 => $f::<i32>($($arg),*),
            SampleFormat::U16 => $f::<u16>($($arg),*),
            other => Err(format!("Unsupported sample format {other:?}")),
        }
    };
}

struct Opened {
    in_stream: Stream,
    out_stream: Stream,
    sample_rate: u32,
    in_block: Arc<AtomicUsize>,
    out_block: Arc<AtomicUsize>,
}

struct Wiring {
    in_dev: Device,
    out_dev: Device,
    in_cfg: StreamConfig,
    out_cfg: StreamConfig,
    in_fmt: SampleFormat,
    out_fmt: SampleFormat,
}

fn wire(host: &str, input: &str, output: &str, buffer: u32, fixed: bool) -> Result<Wiring, String> {
    let host = host_by_name(host)?;
    let in_dev = find_device(&host, input, true)?;
    let out_dev = find_device(&host, output, false)?;
    let in_def = in_dev.default_input_config().map_err(|e| e.to_string())?;
    let out_def = out_dev.default_output_config().map_err(|e| e.to_string())?;
    let rate = in_def.sample_rate();
    let supported = out_dev
        .supported_output_configs()
        .map_err(|e| e.to_string())?
        .any(|c| c.min_sample_rate() <= rate && rate <= c.max_sample_rate() && c.channels() == out_def.channels());
    if !supported {
        return Err(format!("The output device can't run at the input's {} Hz; pick two devices that share a rate", rate.0));
    }
    let in_cfg = StreamConfig { channels: in_def.channels(), sample_rate: SampleRate(rate.0), buffer_size: fixed_or_default(in_def.buffer_size(), buffer, fixed) };
    let out_cfg = StreamConfig { channels: out_def.channels(), sample_rate: SampleRate(rate.0), buffer_size: fixed_or_default(out_def.buffer_size(), buffer, fixed) };
    Ok(Wiring { in_dev, out_dev, in_cfg, out_cfg, in_fmt: in_def.sample_format(), out_fmt: out_def.sample_format() })
}

fn open(
    w: &Wiring,
    in_channel: usize,
    mut sink: impl FnMut(&[f32]) + Send + 'static,
    mut source: impl FnMut(&mut [f32]) + Send + 'static,
) -> Result<Opened, String> {
    let in_block = Arc::new(AtomicUsize::new(0));
    let out_block = Arc::new(AtomicUsize::new(0));
    let ib = in_block.clone();
    let ob = out_block.clone();
    let in_stream = by_format!(w.in_fmt, build_in, &w.in_dev, &w.in_cfg, in_channel, move |s: &[f32]| {
        ib.store(s.len(), Ordering::Relaxed);
        sink(s)
    })?;
    let out_stream = by_format!(w.out_fmt, build_out, &w.out_dev, &w.out_cfg, move |s: &mut [f32]| {
        ob.store(s.len(), Ordering::Relaxed);
        source(s)
    })?;
    Ok(Opened { in_stream, out_stream, sample_rate: w.in_cfg.sample_rate.0, in_block, out_block })
}

fn start(o: &Opened) -> Result<(), String> {
    o.in_stream.play().map_err(|e| e.to_string())?;
    o.out_stream.play().map_err(|e| e.to_string())
}

fn describe(o: &Opened, buffer: u32, fixed: bool) -> String {
    let b = |a: &AtomicUsize| a.load(Ordering::Relaxed);
    let (ib, ob) = (b(&o.in_block), b(&o.out_block));
    let ms = |n: usize| 1000.0 * n as f64 / o.sample_rate as f64;
    format!(
        "{} Hz, asked for {} frames; got blocks of {} in ({:.1} ms) / {} out ({:.1} ms)",
        o.sample_rate,
        if fixed { buffer.to_string() } else { "default".to_string() },
        ib,
        ms(ib),
        ob,
        ms(ob)
    )
}

// ---------- monitor: input straight to output ----------

struct MonitorHandle {
    stop: Sender<()>,
    thread: std::thread::JoinHandle<()>,
}

static MONITOR: Mutex<Option<MonitorHandle>> = Mutex::new(None);

fn stop_monitor() {
    if let Some(m) = MONITOR.lock().unwrap().take() {
        let _ = m.stop.send(());
        let _ = m.thread.join();
    }
}

#[tauri::command]
pub fn native_monitor_start(host: String, input: String, output: String, in_channel: u16, buffer: u32, fixed: bool, gain: f32) -> Result<String, String> {
    stop_monitor();
    let (ready_tx, ready_rx) = channel::<Result<String, String>>();
    let (stop_tx, stop_rx) = channel::<()>();
    let thread = std::thread::spawn(move || {
        let result = (|| {
            let w = wire(&host, &input, &output, buffer, fixed)?;
            let ring = Arc::new(Ring::new(1 << 15));
            let (r_in, r_out) = (ring.clone(), ring);
            // Keep at most a few blocks queued so a clock drift between the two streams can't build up delay.
            let cap = (buffer.max(64) as usize) * 3;
            let o = open(
                &w,
                in_channel as usize,
                move |s| {
                    for v in s {
                        r_in.push(*v * gain);
                    }
                },
                move |out| {
                    let have = r_out.len();
                    if have > cap + out.len() {
                        r_out.skip(have - cap);
                    }
                    for v in out.iter_mut() {
                        *v = r_out.pop().unwrap_or(0.0);
                    }
                },
            )?;
            start(&o)?;
            std::thread::sleep(Duration::from_millis(400));
            let summary = describe(&o, buffer, fixed);
            Ok::<_, String>((o, summary))
        })();
        match result {
            Ok((o, summary)) => {
                let _ = ready_tx.send(Ok(summary));
                let _ = stop_rx.recv(); // streams stay alive until told to stop
                drop(o);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });
    match ready_rx.recv().map_err(|e| e.to_string())? {
        Ok(summary) => {
            *MONITOR.lock().unwrap() = Some(MonitorHandle { stop: stop_tx, thread });
            Ok(summary)
        }
        Err(e) => {
            let _ = thread.join();
            Err(e)
        }
    }
}

#[tauri::command]
pub fn native_monitor_stop() {
    stop_monitor();
}

// ---------- loopback: play clicks, listen for them on the input ----------

#[derive(Serialize)]
pub struct LoopbackResult {
    /// Round trip in ms, or None if the clicks weren't heard clearly.
    ms: Option<f64>,
    hits: usize,
    total: usize,
    detail: String,
}

struct Captured {
    samples: Vec<f32>,
    /// (seconds since t0 at the callback, index of its first sample, its length)
    blocks: Vec<(f64, usize, usize)>,
}

#[tauri::command]
pub async fn native_loopback(host: String, input: String, output: String, in_channel: u16, buffer: u32, fixed: bool) -> Result<LoopbackResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_loopback(&host, &input, &output, in_channel as usize, buffer, fixed)).await.map_err(|e| e.to_string())?
}

fn run_loopback(host: &str, input: &str, output: &str, in_channel: usize, buffer: u32, fixed: bool) -> Result<LoopbackResult, String> {
    stop_monitor();
    let w = wire(host, input, output, buffer, fixed)?;
    let rate = w.in_cfg.sample_rate.0 as f64;
    let t0 = Instant::now();

    // The click: a short two-tone burst, sharp enough to find the start of.
    let click: Vec<f32> = (0..256).map(|i| 0.5 * ((i as f32 * 0.14).sin() + (i as f32 * 0.4).sin()) * 0.5 * (1.0 - i as f32 / 256.0)).collect();
    let starts: Vec<usize> = (0..5).map(|k| ((0.8 + 0.6 * k as f64) * rate) as usize).collect();
    let written: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(Vec::new()));
    let cap = Arc::new(Mutex::new(Captured { samples: Vec::new(), blocks: Vec::new() }));

    let (cap_in, written_out) = (cap.clone(), written.clone());
    let frame = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let st = started.clone();
    let go = started.clone();
    let starts_out = starts.clone();
    let o = open(
        &w,
        in_channel,
        move |s| {
            if !st.load(Ordering::Relaxed) {
                return;
            }
            let now = t0.elapsed().as_secs_f64();
            let mut c = cap_in.lock().unwrap();
            let start = c.samples.len();
            c.samples.extend_from_slice(s);
            c.blocks.push((now, start, s.len()));
        },
        move |out| {
            out.fill(0.0);
            if !started.load(Ordering::Relaxed) {
                return;
            }
            let now = t0.elapsed().as_secs_f64();
            let base = frame.fetch_add(out.len(), Ordering::Relaxed);
            for &s in &starts_out {
                // Any part of a click inside this block is written now; its start is the reference.
                if s + click.len() > base && s < base + out.len() {
                    for (i, o) in out.iter_mut().enumerate() {
                        let n = base + i;
                        if n >= s && n < s + click.len() {
                            *o = click[n - s];
                        }
                    }
                    if s >= base {
                        written_out.lock().unwrap().push(now + (s - base) as f64 / rate);
                    }
                }
            }
        },
    )?;
    start(&o)?;
    std::thread::sleep(Duration::from_millis(300));
    go.store(true, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(4600));
    let summary = describe(&o, buffer, fixed);
    drop(o);

    let c = cap.lock().unwrap();
    let clicks = written.lock().unwrap().clone();
    // Time (seconds since t0) of input sample i: its block's callback time minus what was captured after it.
    let time_of = |i: usize| -> Option<f64> {
        let b = c.blocks.iter().rev().find(|b| b.1 <= i)?;
        Some(b.0 - (b.2 - (i - b.1)) as f64 / rate)
    };
    let quiet_end = (0.25 * rate) as usize;
    let noise = c.samples.iter().take(quiet_end).fold(0.0f32, |m, v| m.max(v.abs()));
    let thr = (noise * 4.0).max(0.02);
    let mut rts = Vec::new();
    for &t in &clicks {
        // First sample over the threshold after the click was written (within 0.5 s).
        for (i, v) in c.samples.iter().enumerate() {
            if v.abs() <= thr {
                continue;
            }
            let Some(ti) = time_of(i) else { continue };
            if ti < t - 0.002 {
                continue;
            }
            if ti > t + 0.5 {
                break;
            }
            rts.push(ti - t);
            break;
        }
    }
    let total = clicks.len();
    rts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = rts.get(rts.len() / 2).copied();
    let consistent = median.map(|m| rts.iter().filter(|r| (**r - m).abs() < 0.006).count()).unwrap_or(0);
    let ms = match median {
        Some(m) if consistent >= 2 && consistent * 10 >= rts.len() * 6 => Some((m * 10000.0).round() / 10.0),
        _ => None,
    };
    Ok(LoopbackResult { ms, hits: consistent, total, detail: summary })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_order_and_drops_when_full() {
        let r = Ring::new(4);
        for v in [1.0, 2.0, 3.0, 4.0, 5.0] {
            r.push(v);
        }
        assert_eq!(r.len(), 4);
        assert_eq!((r.pop(), r.pop()), (Some(1.0), Some(2.0)));
        r.skip(1);
        assert_eq!(r.pop(), Some(4.0));
        assert_eq!(r.pop(), None);
    }

    /// Lists whatever audio devices this machine has; passes on a machine with none.
    #[test]
    fn device_listing_does_not_fail() {
        let devs = native_audio_devices().expect("listing devices");
        for d in &devs {
            println!("{} {} {:?} {}ch {}Hz buf {:?}-{:?}{}", d.host, d.kind, d.name, d.channels, d.sample_rate, d.buffer_min, d.buffer_max, if d.is_default { " (default)" } else { "" });
        }
    }
}
