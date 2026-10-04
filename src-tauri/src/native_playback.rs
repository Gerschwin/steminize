// Native song playback (experimental, desktop only): the Rust port of the web player's engine (src/engine/) running
// inside the sound card's own output callback, so playback doesn't go through the webview's audio pipeline.
//
// The webview stays the user interface. It sends commands (load, play, pause, seek, loop, tempo, gains, practice) and
// receives a position report about 30 times a second as the `native-state` event, the same shape the web player's
// worklet reports (`PlayerReport` in src/player/worklet.ts), so the existing UI can follow it unchanged.
//
// Songs are loaded from the library's FLAC files directly by Rust, not sent over IPC (a song is hundreds of MB of floats).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, Device, FromSample, SampleFormat, SampleRate, SizedSample, Stream, StreamConfig, SupportedBufferSize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::engine::eq::EqParams;
use crate::engine::flac::decode_flac;
use crate::engine::mix::{MixSource, Stereo};
use crate::engine::renderer::Renderer;
use crate::engine::resample::StreamResampler;
use crate::engine::transport::{Practice, Trainer, Transport};

// ---------- what the webview sends ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqDto {
    low_cut: f64,
    high_cut: f64,
    freq: f64,
    gain: f64,
    q: f64,
}

impl From<EqDto> for EqParams {
    fn from(e: EqDto) -> Self {
        EqParams { low_cut: e.low_cut, high_cut: e.high_cut, freq: e.freq, gain: e.gain, q: e.q }
    }
}

#[derive(Deserialize)]
pub struct TrainerDto {
    on: bool,
    from: f64,
    to: f64,
    step: f64,
    every: u32,
    #[serde(default)]
    gate: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeDto {
    gap: f64,
    count_in: bool,
    per_bar: i64,
    beats: Vec<usize>,
    downbeat: i64,
    click: bool,
    click_vol: f32,
    trainer: TrainerDto,
}

impl From<PracticeDto> for Practice {
    fn from(p: PracticeDto) -> Self {
        Practice {
            gap: p.gap,
            count_in: p.count_in,
            per_bar: p.per_bar.max(1),
            beats: p.beats,
            downbeat: p.downbeat,
            click: p.click,
            click_vol: p.click_vol,
            trainer: Trainer { on: p.trainer.on, from: p.trainer.from, to: p.trainer.to, step: p.trainer.step, every: p.trainer.every, gate: p.trainer.gate },
        }
    }
}

#[derive(Deserialize)]
pub struct StemRef {
    name: String,
    scale: f32,
}

/// What the webview is told about playback; the same fields as the web player's report.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateReport {
    pos: f64,
    playing: bool,
    ended: bool,
    passes: u32,
    tempo: f64,
    counting_in: bool,
}

// ---------- the engine, living in the audio callback ----------

enum Cmd {
    Load(Box<Transport>),
    Play,
    Pause,
    Seek(f64),
    Loop { on: bool, start: usize, end: usize },
    Tempo { tempo: f64, pitch: f64 },
    Gains { gains: Vec<f32>, pans: Vec<f64>, eqs: Vec<Option<EqParams>> },
    Practice(Box<Practice>),
}

/// Written by the audio callback, read by the reporter thread; atomics so neither ever waits for the other.
#[derive(Default)]
struct Shared {
    pos: AtomicU64, // f64 bits
    tempo: AtomicU64,
    playing: AtomicBool,
    counting_in: AtomicBool,
    ended: AtomicBool, // set when a song plays to its end, cleared by the reporter once it has said so
    passes: AtomicU32,
}

struct Engine {
    t: Option<Box<Transport>>,
    playing: bool,
    rs: Option<StreamResampler>,
    rx: Receiver<Cmd>,
    shared: Arc<Shared>,
    /// Old songs are freed on another thread: dropping hundreds of MB in the audio callback would glitch it.
    garbage: Sender<Box<Transport>>,
    // What the transport should have when a new song arrives, as in the web worklet.
    looping: (bool, usize, usize),
    tempo: (f64, f64),
    practice: Practice,
}

impl Engine {
    fn apply(&mut self, c: Cmd) {
        match c {
            Cmd::Load(mut t) => {
                t.r.set_tempo_pitch(self.tempo.0, self.tempo.1);
                t.set_loop(self.looping.0, self.looping.1, self.looping.2);
                t.set_practice(self.practice.clone());
                if let Some(old) = self.t.replace(t) {
                    let _ = self.garbage.send(old);
                }
                self.playing = false;
                if let Some(rs) = &mut self.rs {
                    rs.reset();
                }
            }
            Cmd::Loop { on, start, end } => {
                self.looping = (on, start, end);
                if let Some(t) = &mut self.t {
                    t.set_loop(on, start, end);
                }
            }
            Cmd::Tempo { tempo, pitch } => {
                self.tempo = (tempo, pitch);
                if let Some(t) = &mut self.t {
                    t.r.set_tempo_pitch(tempo, pitch);
                }
            }
            Cmd::Practice(p) => {
                self.practice = (*p).clone();
                if let Some(t) = &mut self.t {
                    t.set_practice(*p);
                }
            }
            Cmd::Gains { gains, pans, eqs } => {
                if let Some(t) = &mut self.t {
                    t.r.src.gains = gains;
                    t.r.src.pans = pans;
                    t.r.src.set_eqs(&eqs);
                }
            }
            Cmd::Play => {
                if let (Some(t), false) = (&mut self.t, self.playing) {
                    if let Some(rs) = &mut self.rs {
                        rs.reset();
                    }
                    t.on_play();
                    self.playing = true;
                }
            }
            Cmd::Pause => self.playing = false,
            Cmd::Seek(pos) => {
                if let Some(rs) = &mut self.rs {
                    rs.reset();
                }
                if let Some(t) = &mut self.t {
                    t.seek(pos);
                }
            }
        }
    }

    /// Fills one block of output.
    fn fill(&mut self, l: &mut [f32], r: &mut [f32]) {
        while let Ok(c) = self.rx.try_recv() {
            self.apply(c);
        }
        let n = l.len();
        match (&mut self.t, self.playing) {
            (Some(t), true) => {
                let ok = match &mut self.rs {
                    Some(rs) => rs.render(|a, b, k| t.render(a, b, k), l, r, n),
                    None => t.render(l, r, n),
                };
                if !ok {
                    self.playing = false;
                    t.seek(0.0);
                    if let Some(rs) = &mut self.rs {
                        rs.reset();
                    }
                    self.shared.ended.store(true, Ordering::Relaxed);
                }
            }
            _ => {
                l.fill(0.0);
                r.fill(0.0);
            }
        }
        let sh = &self.shared;
        if let Some(t) = &self.t {
            sh.pos.store(t.r.heard.to_bits(), Ordering::Relaxed);
            sh.tempo.store(t.r.tempo.to_bits(), Ordering::Relaxed);
            sh.passes.store(t.passes, Ordering::Relaxed);
            sh.counting_in.store(t.pausing(), Ordering::Relaxed);
        }
        sh.playing.store(self.playing, Ordering::Relaxed);
    }
}

// ---------- the output stream ----------

fn build_stereo_out<T>(dev: &Device, cfg: &StreamConfig, mut engine: Engine) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let ch = cfg.channels as usize;
    let (mut l, mut r) = (Vec::<f32>::new(), Vec::<f32>::new());
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], _| {
            let frames = data.len() / ch;
            if l.len() < frames {
                l.resize(frames, 0.0);
                r.resize(frames, 0.0);
            }
            engine.fill(&mut l[..frames], &mut r[..frames]);
            for (i, frame) in data.chunks_mut(ch).enumerate() {
                for (c, s) in frame.iter_mut().enumerate() {
                    // Stereo goes to the first two channels; any others stay silent.
                    *s = T::from_sample(match c {
                        0 => l[i],
                        1 => r[i],
                        _ => 0.0,
                    });
                }
            }
        },
        |e| eprintln!("native playback stream error: {e}"),
        None,
    )
    .map_err(|e| e.to_string())
}

struct Handle {
    tx: Sender<Cmd>,
    stop: Sender<()>,
    thread: std::thread::JoinHandle<()>,
    sample_rate: u32,
}

static ENGINE: Mutex<Option<Handle>> = Mutex::new(None);

fn stop_engine() {
    if let Some(h) = ENGINE.lock().unwrap().take() {
        let _ = h.stop.send(());
        let _ = h.thread.join();
    }
}

fn send(c: Cmd) -> Result<(), String> {
    let g = ENGINE.lock().unwrap();
    let h = g.as_ref().ok_or("The native engine isn't running")?;
    h.tx.send(c).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn native_engine_start(app: AppHandle, host: String, output: String, buffer: u32, fixed: bool, rate: u32) -> Result<String, String> {
    start_engine(Box::new(move |report| {
        let _ = app.emit("native-state", report);
    }), host, output, buffer, fixed, rate)
}

/// Opens the output stream and starts reporting position through `report` (the Tauri event in the app, a collector in tests).
fn start_engine(report: Box<dyn Fn(StateReport) + Send>, host: String, output: String, buffer: u32, fixed: bool, rate: u32) -> Result<String, String> {
    stop_engine();
    let (ready_tx, ready_rx) = channel::<Result<(String, u32), String>>();
    let (stop_tx, stop_rx) = channel::<()>();
    let (tx, rx) = channel::<Cmd>();
    let shared = Arc::new(Shared::default());
    let reporter_shared = shared.clone();
    let thread = std::thread::spawn(move || {
        let setup = || -> Result<(Stream, String, u32), String> {
            let host = crate::native_audio::host_by_name(&host)?;
            let dev = crate::native_audio::find_device(&host, &output, false)?;
            let def = dev.default_output_config().map_err(|e| e.to_string())?;
            let hz = if rate > 0 { rate } else { def.sample_rate().0 };
            let buffer_size = if !fixed {
                BufferSize::Default
            } else {
                match def.buffer_size() {
                    SupportedBufferSize::Range { min, max } => BufferSize::Fixed(buffer.clamp(*min, *max)),
                    SupportedBufferSize::Unknown => BufferSize::Fixed(buffer),
                }
            };
            let cfg = StreamConfig { channels: def.channels(), sample_rate: SampleRate(hz), buffer_size };
            let (garbage_tx, garbage_rx) = channel::<Box<Transport>>();
            std::thread::spawn(move || while garbage_rx.recv().is_ok() {});
            let engine = Engine {
                t: None,
                playing: false,
                rs: if hz == 44100 { None } else { Some(StreamResampler::new(44100, hz)) },
                rx,
                shared: shared.clone(),
                garbage: garbage_tx,
                looping: (false, 0, 0),
                tempo: (1.0, 0.0),
                practice: Practice::default(),
            };
            let stream = match def.sample_format() {
                SampleFormat::F32 => build_stereo_out::<f32>(&dev, &cfg, engine),
                SampleFormat::I16 => build_stereo_out::<i16>(&dev, &cfg, engine),
                SampleFormat::I32 => build_stereo_out::<i32>(&dev, &cfg, engine),
                SampleFormat::U16 => build_stereo_out::<u16>(&dev, &cfg, engine),
                f => Err(format!("Unsupported sample format {f:?}")),
            }?;
            stream.play().map_err(|e| e.to_string())?;
            Ok((stream, format!("{hz} Hz, {} output channels", cfg.channels), hz))
        };
        match setup() {
            Ok((stream, summary, hz)) => {
                let _ = ready_tx.send(Ok((summary, hz)));
                // Report position about 30 times a second until told to stop.
                loop {
                    match stop_rx.recv_timeout(Duration::from_millis(33)) {
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        _ => break,
                    }
                    let sh = &reporter_shared;
                    report(StateReport {
                        pos: f64::from_bits(sh.pos.load(Ordering::Relaxed)),
                        playing: sh.playing.load(Ordering::Relaxed),
                        ended: sh.ended.swap(false, Ordering::Relaxed),
                        passes: sh.passes.load(Ordering::Relaxed),
                        tempo: f64::from_bits(sh.tempo.load(Ordering::Relaxed)).max(0.01),
                        counting_in: sh.counting_in.load(Ordering::Relaxed),
                    });
                }
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    });
    match ready_rx.recv().map_err(|e| e.to_string())? {
        Ok((summary, hz)) => {
            *ENGINE.lock().unwrap() = Some(Handle { tx, stop: stop_tx, thread, sample_rate: hz });
            Ok(summary)
        }
        Err(e) => {
            let _ = thread.join();
            Err(e)
        }
    }
}

#[tauri::command]
pub fn native_engine_stop() {
    stop_engine();
}

/// Loads a saved song's stems from the library by id (FLAC files, undoing each file's stored scale) and returns its length
/// in frames. Takes a while for a long song, so it runs off the main thread.
#[tauri::command]
pub async fn native_engine_load(app: AppHandle, id: String, stems: Vec<StemRef>, gains: Vec<f32>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::library::lib_root(&app)?.join(crate::library::safe_component(&id, "song id")?);
        load_song(&dir, &stems, gains)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads the stems from `dir`, builds the transport and hands it to the running engine; returns the song's length in frames.
fn load_song(dir: &std::path::Path, stems: &[StemRef], gains: Vec<f32>) -> Result<usize, String> {
    let mut loaded: Vec<Stereo> = Vec::with_capacity(stems.len());
    for s in stems {
        let name = crate::library::safe_component(&s.name, "stem name")?;
        let bytes = std::fs::read(dir.join(format!("{name}.flac"))).map_err(|e| format!("{name}: {e}"))?;
        loaded.push(decode_flac(&bytes, s.scale).map_err(|e| format!("{name}: {e}"))?);
    }
    let len = loaded.iter().map(|s| s.0.len()).max().unwrap_or(0);
    for s in &mut loaded {
        s.0.resize(len, 0.0);
        s.1.resize(len, 0.0);
    }
    let mut src = MixSource::new(loaded, gains, len);
    src.pad_end = 32768;
    send(Cmd::Load(Box::new(Transport::new(Renderer::new(src)))))?;
    Ok(len)
}

#[tauri::command]
pub fn native_engine_play() -> Result<(), String> {
    send(Cmd::Play)
}

#[tauri::command]
pub fn native_engine_pause() -> Result<(), String> {
    send(Cmd::Pause)
}

#[tauri::command]
pub fn native_engine_seek(pos: f64) -> Result<(), String> {
    send(Cmd::Seek(pos))
}

#[tauri::command]
pub fn native_engine_loop(on: bool, start: usize, end: usize) -> Result<(), String> {
    send(Cmd::Loop { on, start, end })
}

#[tauri::command]
pub fn native_engine_tempo(tempo: f64, pitch: f64) -> Result<(), String> {
    send(Cmd::Tempo { tempo, pitch })
}

#[tauri::command]
pub fn native_engine_gains(gains: Vec<f32>, pans: Option<Vec<f64>>, eqs: Option<Vec<Option<EqDto>>>) -> Result<(), String> {
    send(Cmd::Gains { gains, pans: pans.unwrap_or_default(), eqs: eqs.unwrap_or_default().into_iter().map(|e| e.map(Into::into)).collect() })
}

#[tauri::command]
pub fn native_engine_practice(practice: PracticeDto) -> Result<(), String> {
    send(Cmd::Practice(Box::new(practice.into())))
}

#[tauri::command]
pub fn native_engine_rate() -> Option<u32> {
    ENGINE.lock().unwrap().as_ref().map(|h| h.sample_rate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// Plays a saved song for a few seconds through the PipeWire `pulse` device into a null sink and records it back with
    /// `parec`, checking the engine produces sound, reports position and follows play / pause. Needs a real library song
    /// and a null sink, so it only runs when asked:
    ///   pactl load-module module-null-sink sink_name=natest
    ///   NA_SONG_DIR=~/.local/share/app.steminize.desktop/library/<id> PULSE_SINK=natest \
    ///     cargo test native_playback_plays -- --ignored --nocapture
    #[test]
    #[ignore]
    fn native_playback_plays() {
        let dir = std::path::PathBuf::from(std::env::var("NA_SONG_DIR").expect("NA_SONG_DIR"));
        let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        let stems: Vec<StemRef> = meta["stems"].as_array().unwrap().iter().map(|s| StemRef { name: s["name"].as_str().unwrap().to_string(), scale: s["scale"].as_f64().unwrap() as f32 }).collect();
        let reports = Arc::new(Mutex::new(Vec::<StateReport>::new()));
        let r2 = reports.clone();
        let summary = start_engine(Box::new(move |r| r2.lock().unwrap().push(r)), "ALSA".into(), "pulse".into(), 256, true, 0).expect("start");
        let gains = vec![1.0; stems.len()];
        let t = std::time::Instant::now();
        let len = load_song(&dir, &stems, gains).expect("load");
        println!("{summary}; loaded {} stems, {len} frames ({:.1}s) in {:.2}s", stems.len(), len as f64 / 44100.0, t.elapsed().as_secs_f64());

        let mut rec = Command::new("parec").args(["--device=natest.monitor", "--format=float32le", "--rate=44100", "--channels=2", "--latency-msec=20"]).stdout(Stdio::piped()).spawn().expect("parec");
        let mut out = rec.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let (mut all, mut buf) = (Vec::new(), [0u8; 8192]);
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..n]);
            }
            all
        });
        std::thread::sleep(Duration::from_millis(300));
        send(Cmd::Seek(44100.0 * 5.0)).unwrap();
        send(Cmd::Play).unwrap();
        std::thread::sleep(Duration::from_millis(2500));
        send(Cmd::Pause).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let _ = rec.kill();
        let bytes = reader.join().unwrap();
        let samples: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let secs = |a: f64, b: f64| &samples[(a * 88200.0) as usize..((b * 88200.0) as usize).min(samples.len())];
        let rms = |x: &[f32]| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt();
        let during = rms(secs(0.8, 2.6));
        let after = rms(secs(3.0, 3.25));
        let last = reports.lock().unwrap().last().cloned().unwrap();
        println!("recorded {:.1}s; rms while playing {during:.4}, after pause {after:.5}; last report pos {:.0} playing {}", samples.len() as f64 / 88200.0, last.pos, last.playing);
        stop_engine();
        assert!(during > 0.005, "no sound while playing");
        assert!(after < during * 0.05, "still sounding after pause");
        assert!(last.pos > 44100.0 * 5.0 + 44100.0, "position didn't advance: {}", last.pos);
        assert!(!last.playing);
    }
}
