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
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, Device, FromSample, SampleFormat, SampleRate, SizedSample, Stream, StreamConfig, SupportedBufferSize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::engine::eq::EqParams;
use crate::native_audio::{build_in, by_format, fixed_or_default};
use crate::native_input::{InputShared, RecState, MAX_TAKE_SECS};
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
    /// Peak of the live input since the last report (0 to 1), for the meter.
    level: f32,
    /// How busy the audio callback was (1 = it used the whole block's time), and how many glitches there have been.
    load: f32,
    dropouts: u32,
}

/// Sent once when a stream fails.
#[derive(Clone, Serialize)]
pub struct StreamFailure {
    fatal: bool,
    message: String,
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
    Volume(f32),
    AddTrack(Stereo),
    ReplaceTrack(usize, Stereo),
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
    /// Busiest block since the last report, as a fraction of the time the block lasts (f32 bits); over 1 means it ran late.
    load: AtomicU32,
    /// Blocks that arrived much later than they should have (the audio glitched), since the engine started.
    dropouts: AtomicU32,
}

struct Engine {
    t: Option<Box<Transport>>,
    playing: bool,
    rs: Option<StreamResampler>,
    rx: Receiver<Cmd>,
    shared: Arc<Shared>,
    /// Old songs are freed on another thread: dropping hundreds of MB in the audio callback would glitch it.
    garbage: Sender<Box<dyn std::any::Any + Send>>,
    // What the transport should have when a new song arrives, as in the web worklet.
    looping: (bool, usize, usize),
    tempo: (f64, f64),
    practice: Practice,
    volume: f32,
    /// The live input (monitor, recording) and where the song was when, for placing takes.
    input: Arc<InputShared>,
    mon_primed: bool,
    /// Output rate, and when the previous block was asked for, to spot blocks that came late.
    hz: u32,
    last_block: Option<Instant>,
}

impl Engine {
    fn apply(&mut self, c: Cmd) {
        match c {
            Cmd::Load(mut t) => {
                t.r.set_tempo_pitch(self.tempo.0, self.tempo.1);
                t.set_loop(self.looping.0, self.looping.1, self.looping.2);
                t.set_practice(self.practice.clone());
                if let Some(old) = self.t.replace(t) {
                    let _ = self.garbage.send(Box::new(old));
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
            Cmd::Volume(v) => self.volume = v,
            Cmd::AddTrack(stem) => {
                if let Some(t) = &mut self.t {
                    t.r.src.stems.push(stem);
                }
            }
            Cmd::ReplaceTrack(i, stem) => {
                if let Some(t) = &mut self.t {
                    if let Some(slot) = t.r.src.stems.get_mut(i) {
                        let old = std::mem::replace(slot, stem);
                        let _ = self.garbage.send(Box::new(old));
                    }
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
        let started = Instant::now();
        let block_secs = l.len() as f64 / self.hz as f64;
        // Blocks are asked for at a steady pace; one that comes far later than that means the audio glitched.
        if let Some(prev) = self.last_block {
            if started.duration_since(prev).as_secs_f64() > block_secs * 2.5 + 0.002 {
                self.shared.dropouts.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.last_block = Some(started);
        self.fill_block(l, r);
        let load = (started.elapsed().as_secs_f64() / block_secs) as f32;
        if load > f32::from_bits(self.shared.load.load(Ordering::Relaxed)) {
            self.shared.load.store(load.to_bits(), Ordering::Relaxed);
        }
    }

    fn fill_block(&mut self, l: &mut [f32], r: &mut [f32]) {
        while let Ok(c) = self.rx.try_recv() {
            self.apply(c);
        }
        let n = l.len();
        // Tell the input side where the song is at this moment, and how fast it is moving.
        let (here, speed) = match (&self.t, self.playing) {
            (Some(t), true) if !t.pausing() => (t.r.audible(), 44100.0 * t.r.tempo),
            (Some(t), _) => (t.r.audible(), 0.0),
            _ => (0.0, 0.0),
        };
        self.input.note_output(here, speed);
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
        if self.volume != 1.0 {
            for v in l.iter_mut().chain(r.iter_mut()) {
                *v *= self.volume;
            }
        }
        self.input.mix_into(l, r, &mut self.mon_primed);
        let sh = &self.shared;
        if let Some(t) = &self.t {
            sh.pos.store(t.r.audible().to_bits(), Ordering::Relaxed);
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
        crate::native_audio::err_fn,
        None,
    )
    .map_err(|e| e.to_string())
}

/// Things only the thread that owns the streams can do.
enum Ctl {
    OpenInput { input: String, channel: usize, buffer: u32, fixed: bool, reply: Sender<Result<String, String>> },
    CloseInput,
}

struct Handle {
    tx: Sender<Cmd>,
    ctl: Sender<Ctl>,
    input: Arc<InputShared>,
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
    let failed = app.clone();
    start_engine(
        Box::new(move |report| {
            let _ = app.emit("native-state", report);
        }),
        Box::new(move |failure| {
            let _ = failed.emit("native-error", failure);
        }),
        host,
        output,
        buffer,
        fixed,
        rate,
    )
}

/// Opens the output stream and starts reporting position through `report` (the Tauri event in the app, a collector in tests).
fn start_engine(report: Box<dyn Fn(StateReport) + Send>, on_failure: Box<dyn Fn(StreamFailure) + Send>, host: String, output: String, buffer: u32, fixed: bool, rate: u32) -> Result<String, String> {
    stop_engine();
    let _ = crate::native_audio::take_stream_error(); // anything left over from an earlier stream is not about this one
    let (ready_tx, ready_rx) = channel::<Result<(String, u32, Arc<InputShared>), String>>();
    let (ctl_tx, ctl_rx) = channel::<Ctl>();
    let host_name = host.clone();
    let (stop_tx, stop_rx) = channel::<()>();
    let (tx, rx) = channel::<Cmd>();
    let shared = Arc::new(Shared::default());
    let reporter_shared = shared.clone();
    let thread = std::thread::spawn(move || {
        let setup = || -> Result<(Stream, String, u32, Arc<InputShared>), String> {
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
            let input = Arc::new(InputShared::new(hz));
            let (garbage_tx, garbage_rx) = channel::<Box<dyn std::any::Any + Send>>();
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
                volume: 1.0,
                input: input.clone(),
                mon_primed: false,
                hz,
                last_block: None,
            };
            let stream = match def.sample_format() {
                SampleFormat::F32 => build_stereo_out::<f32>(&dev, &cfg, engine),
                SampleFormat::I16 => build_stereo_out::<i16>(&dev, &cfg, engine),
                SampleFormat::I32 => build_stereo_out::<i32>(&dev, &cfg, engine),
                SampleFormat::U16 => build_stereo_out::<u16>(&dev, &cfg, engine),
                f => Err(format!("Unsupported sample format {f:?}")),
            }?;
            stream.play().map_err(|e| e.to_string())?;
            Ok((stream, format!("{hz} Hz, {} output channels", cfg.channels), hz, input))
        };
        match setup() {
            Ok((stream, summary, hz, input)) => {
                let _ = ready_tx.send(Ok((summary, hz, input.clone())));
                let mut input_stream: Option<Stream> = None;
                // Report position about 30 times a second until told to stop.
                loop {
                    match stop_rx.recv_timeout(Duration::from_millis(33)) {
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        _ => break,
                    }
                    while let Ok(c) = ctl_rx.try_recv() {
                        match c {
                            Ctl::OpenInput { input: name, channel, buffer, fixed, reply } => {
                                input_stream = None;
                                input.active.store(false, Ordering::Relaxed);
                                let opened = open_input(&host_name, &name, channel, buffer, fixed, hz, &input);
                                let _ = reply.send(match opened {
                                    Ok((stream, summary)) => {
                                        input_stream = Some(stream);
                                        input.active.store(true, Ordering::Relaxed);
                                        Ok(summary)
                                    }
                                    Err(e) => Err(e),
                                });
                            }
                            Ctl::CloseInput => {
                                input_stream = None;
                                input.active.store(false, Ordering::Relaxed);
                            }
                        }
                    }
                    if let Some(p) = crate::native_audio::take_stream_error() {
                        on_failure(StreamFailure { fatal: p.fatal, message: p.message });
                    }
                    let sh = &reporter_shared;
                    report(StateReport {
                        level: input.take_level(),
                        load: f32::from_bits(sh.load.swap(0, Ordering::Relaxed)),
                        dropouts: sh.dropouts.load(Ordering::Relaxed),
                        pos: f64::from_bits(sh.pos.load(Ordering::Relaxed)),
                        playing: sh.playing.load(Ordering::Relaxed),
                        ended: sh.ended.swap(false, Ordering::Relaxed),
                        passes: sh.passes.load(Ordering::Relaxed),
                        tempo: f64::from_bits(sh.tempo.load(Ordering::Relaxed)).max(0.01),
                        counting_in: sh.counting_in.load(Ordering::Relaxed),
                    });
                }
                drop(input_stream);
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(crate::native_audio::friendly_error(&e)));
            }
        }
    });
    match ready_rx.recv().map_err(|e| e.to_string())? {
        Ok((summary, hz, input)) => {
            *ENGINE.lock().unwrap() = Some(Handle { tx, ctl: ctl_tx, input, stop: stop_tx, thread, sample_rate: hz });
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
pub async fn native_engine_load(app: AppHandle, id: String, gains: Vec<f32>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::library::lib_root(&app)?.join(crate::library::safe_component(&id, "song id")?);
        load_song(&dir, gains)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The files of a saved song in track order: its stems, then the active (or latest) take of each recorded source, which
/// is the order the deck lays its tracks out in (see `restoreTakes` in deck.ts).
fn song_files(meta: &serde_json::Value) -> Result<Vec<(String, f32)>, String> {
    let mut files = Vec::new();
    for s in meta["stems"].as_array().ok_or("The song has no stems")? {
        files.push((s["name"].as_str().ok_or("stem without a name")?.to_string(), s["scale"].as_f64().unwrap_or(1.0) as f32));
    }
    for g in meta["takeGroups"].as_array().into_iter().flatten() {
        let gid = g["id"].as_str().ok_or("take group without an id")?;
        let takes = g["takes"].as_array().map(|t| t.as_slice()).unwrap_or(&[]);
        let active = g["activeTake"].as_str();
        let take = takes.iter().find(|t| t["id"].as_str() == active).or_else(|| takes.last());
        if let Some(t) = take {
            files.push((format!("{gid}-{}", t["id"].as_str().ok_or("take without an id")?), t["scale"].as_f64().unwrap_or(1.0) as f32));
        }
    }
    Ok(files)
}

/// Reads a saved song's files, builds the transport and hands it to the running engine; returns the song's length in frames.
fn load_song(dir: &std::path::Path, gains: Vec<f32>) -> Result<usize, String> {
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).map_err(|e| format!("meta.json: {e}"))?).map_err(|e| e.to_string())?;
    let mut loaded: Vec<Stereo> = Vec::new();
    for (name, scale) in song_files(&meta)? {
        let name = crate::library::safe_component(&name, "track name")?;
        let bytes = std::fs::read(dir.join(format!("{name}.flac"))).map_err(|e| format!("{name}: {e}"))?;
        loaded.push(decode_flac(&bytes, scale).map_err(|e| format!("{name}: {e}"))?);
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

/// A track's audio sent as raw bytes: little-endian f32, all of the left channel then all of the right. Headers: `mode`
/// is "add" or "replace", and `index` is the track slot to replace. Used for takes recorded or switched while a song plays.
#[tauri::command]
pub fn native_engine_track(request: tauri::ipc::Request) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw audio bytes".into()) };
    let h = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let floats: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let half = floats.len() / 2;
    let stem: Stereo = (floats[..half].to_vec(), floats[half..half * 2].to_vec());
    match h("mode").as_deref() {
        Some("add") => send(Cmd::AddTrack(stem)),
        Some("replace") => send(Cmd::ReplaceTrack(h("index").and_then(|i| i.parse().ok()).ok_or("missing track index")?, stem)),
        _ => Err("mode must be add or replace".into()),
    }
}

#[tauri::command]
pub fn native_engine_volume(v: f32) -> Result<(), String> {
    send(Cmd::Volume(v))
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

/// Opens the live input at the engine's rate, on the same audio system as the output.
fn open_input(host: &str, name: &str, channel: usize, buffer: u32, fixed: bool, hz: u32, shared: &Arc<InputShared>) -> Result<(Stream, String), String> {
    let host = crate::native_audio::host_by_name(host)?;
    let dev = crate::native_audio::find_device(&host, name, true)?;
    let def = dev.default_input_config().map_err(|e| e.to_string())?;
    let supported = dev
        .supported_input_configs()
        .map_err(|e| e.to_string())?
        .any(|c| c.min_sample_rate().0 <= hz && hz <= c.max_sample_rate().0 && c.channels() == def.channels());
    if !supported {
        return Err(format!("The input can't run at the output's {hz} Hz; pick devices that share a rate"));
    }
    let cfg = StreamConfig { channels: def.channels(), sample_rate: SampleRate(hz), buffer_size: fixed_or_default(def.buffer_size(), buffer, fixed) };
    let sh = shared.clone();
    let stream = by_format!(def.sample_format(), build_in, &dev, &cfg, channel, move |s: &[f32]| sh.on_input(s))?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, format!("{} input channels at {hz} Hz", def.channels())))
}

fn input_shared() -> Result<Arc<InputShared>, String> {
    ENGINE.lock().unwrap().as_ref().map(|h| h.input.clone()).ok_or_else(|| "The native engine isn't running".to_string())
}

/// Opens the live input (an input device on the same audio system as the output). Returns a short description.
#[tauri::command]
pub async fn native_input_start(input: String, channel: u16, buffer: u32, fixed: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || input_start_blocking(input, channel, buffer, fixed)).await.map_err(|e| e.to_string())?
}

fn input_start_blocking(input: String, channel: u16, buffer: u32, fixed: bool) -> Result<String, String> {
    let (reply, answer) = channel_pair();
    {
        let g = ENGINE.lock().unwrap();
        let h = g.as_ref().ok_or("The native engine isn't running")?;
        h.ctl.send(Ctl::OpenInput { input, channel: channel as usize, buffer, fixed, reply }).map_err(|e| e.to_string())?;
    }
    answer.recv_timeout(Duration::from_secs(5)).map_err(|_| "Timed out opening the input".to_string())?.map_err(|e| crate::native_audio::friendly_error(&e))
}

fn channel_pair() -> (Sender<Result<String, String>>, Receiver<Result<String, String>>) {
    channel()
}

#[tauri::command]
pub fn native_input_stop() -> Result<(), String> {
    let g = ENGINE.lock().unwrap();
    if let Some(h) = g.as_ref() {
        *h.input.rec.lock().unwrap() = None;
        h.input.set_monitor(false, 0.0, 0.0);
        h.ctl.send(Ctl::CloseInput).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Monitor on / off and its level and pan.
#[tauri::command]
pub fn native_input_set(monitor: bool, gain: f32, pan: f32) -> Result<(), String> {
    input_shared()?.set_monitor(monitor, gain, pan);
    Ok(())
}

/// The last few thousand input samples for the tuner and the Trainer: the sample rate (u32, little-endian) then f32 samples.
#[tauri::command]
pub fn native_input_snapshot() -> Result<tauri::ipc::Response, String> {
    let sh = input_shared()?;
    let samples = sh.snapshot();
    let mut out = Vec::with_capacity(4 + samples.len() * 4);
    out.extend_from_slice(&sh.rate.to_le_bytes());
    for v in samples {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(out))
}

/// Starts recording a take. `rt_ms` is the round-trip delay to take off so the take lands in time with the song.
#[tauri::command]
pub fn native_record_start(rt_ms: f64) -> Result<(), String> {
    let sh = input_shared()?;
    if !sh.active.load(Ordering::Relaxed) {
        return Err("Start monitoring first.".into());
    }
    let capacity = sh.rate as usize * MAX_TAKE_SECS;
    *sh.rec.lock().unwrap() = Some(RecState { samples: Vec::with_capacity(capacity), rt_secs: rt_ms.max(0.0) / 1000.0, start_pos: None });
    Ok(())
}

/// Stops recording and returns the take as raw bytes: an f64 (little-endian) with the song frame the take starts at, with the
/// round trip already taken off, then the mono audio as f32 at 44.1 kHz.
#[tauri::command]
pub fn native_record_stop() -> Result<tauri::ipc::Response, String> {
    record_stop_bytes().map(tauri::ipc::Response::new)
}

fn record_stop_bytes() -> Result<Vec<u8>, String> {
    let sh = input_shared()?;
    let rec = sh.rec.lock().unwrap().take().ok_or("Not recording")?;
    let mut samples = rec.samples;
    if sh.rate != 44100 {
        let mut rs = StreamResampler::new(sh.rate, 44100);
        let want = (samples.len() as f64 * 44100.0 / sh.rate as f64) as usize;
        let mut at = 0usize;
        let (mut out, mut scratch) = (vec![0f32; want], vec![0f32; want.min(1 << 16).max(1)]);
        let mut o = 0;
        while o < want {
            let k = (want - o).min(scratch.len());
            let src = &samples;
            rs.render(
                |a, b, n| {
                    for i in 0..n {
                        let v = src.get(at + i).copied().unwrap_or(0.0);
                        a[i] = v;
                        b[i] = v;
                    }
                    at += n;
                    true
                },
                &mut out[o..o + k],
                &mut scratch[..k],
                k,
            );
            o += k;
        }
        samples = out;
    }
    let mut bytes = Vec::with_capacity(8 + samples.len() * 4);
    bytes.extend_from_slice(&rec.start_pos.unwrap_or(0.0).to_le_bytes());
    for v in samples {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    Ok(bytes)
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
        let stems = song_files(&meta).unwrap();
        let reports = Arc::new(Mutex::new(Vec::<StateReport>::new()));
        let r2 = reports.clone();
        let summary = start_engine(Box::new(move |r| r2.lock().unwrap().push(r)), Box::new(|_| {}), "ALSA".into(), "pulse".into(), 256, true, 0).expect("start");
        let gains = vec![1.0; stems.len()];
        let t = std::time::Instant::now();
        let len = load_song(&dir, gains).expect("load");
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

    /// A take recorded while the song plays lines up with the song. The null sink plays the song out and is also the input
    /// (a perfect loopback), so the take is the song itself, delayed by the round trip; after the engine takes the measured
    /// round trip off, comparing the take with the song's own audio should show almost no lag.
    ///   pactl load-module module-null-sink sink_name=natest
    ///   NA_SONG_DIR=~/.local/share/app.steminize.desktop/library/<id> PULSE_SINK=natest PULSE_SOURCE=natest.monitor \
    ///     cargo test native_take_lines_up -- --ignored --nocapture
    #[test]
    #[ignore]
    fn native_take_lines_up() {
        let dir = std::path::PathBuf::from(std::env::var("NA_SONG_DIR").expect("NA_SONG_DIR"));
        // The round trip of this exact setup, measured the way the app does.
        let lb = crate::native_audio::run_loopback_for_test("pulse", "pulse", 128);
        let rt_ms = lb.expect("loopback should hear itself");
        println!("measured round trip {rt_ms} ms");

        start_engine(Box::new(|_| {}), Box::new(|_| {}), "ALSA".into(), "pulse".into(), 128, true, 0).expect("start");
        println!("input: {}", input_start_blocking("pulse".into(), 0, 128, true).expect("input"));
        let len = load_song(&dir, vec![1.0, 1.0, 1.0]).expect("load");
        send(Cmd::Seek(44100.0 * 2.0)).unwrap();
        send(Cmd::Play).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        *input_shared().unwrap().rec.lock().unwrap() = Some(RecState { samples: Vec::with_capacity(44100 * 10), rt_secs: rt_ms / 1000.0, start_pos: None });
        std::thread::sleep(Duration::from_millis(5000));
        let bytes = record_stop_bytes().expect("take");
        send(Cmd::Pause).unwrap();
        stop_engine();

        let start = f64::from_le_bytes(bytes[..8].try_into().unwrap());
        let take: Vec<f32> = bytes[8..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        // The song's own left channel, mixed the way the engine mixed it.
        let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        let mut mix = vec![0f32; len];
        for (name, scale) in song_files(&meta).unwrap() {
            let (l, _) = decode_flac(&std::fs::read(dir.join(format!("{name}.flac"))).unwrap(), scale).unwrap();
            for (i, v) in l.iter().enumerate() {
                mix[i] += v;
            }
        }
        // The take is mono from the left channel; find how far it is from the song around where it was placed.
        let start = start.round() as i64;
        let (from, to) = (44100usize, take.len().min(44100 * 4));
        let mut best = (0i64, f64::MIN);
        for lag in -2200i64..=2200 {
            let mut dot = 0.0f64;
            for i in from..to {
                let j = start + i as i64 + lag;
                if j >= 0 && (j as usize) < mix.len() {
                    dot += take[i] as f64 * mix[j as usize] as f64;
                }
            }
            if dot > best.1 {
                best = (lag, dot);
            }
        }
        println!("take starts at song frame {start}, {} samples; best lag {} samples = {:.2} ms", take.len(), best.0, best.0 as f64 / 44.1);
        assert!(best.0.abs() < 132, "take is {:.1} ms off the song", best.0 as f64 / 44.1);
    }

    /// Checks the newest saved take in a song folder against the song itself, to see how well a take recorded through the
    /// app lines up (needs a loopback so the take contains the song). `NA_SONG_DIR=<library/song-id>`.
    #[test]
    #[ignore]
    fn saved_take_lines_up() {
        let dir = std::path::PathBuf::from(std::env::var("NA_SONG_DIR").expect("NA_SONG_DIR"));
        let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        let groups = meta["takeGroups"].as_array().expect("takeGroups");
        let g = groups.last().unwrap();
        let takes = g["takes"].as_array().unwrap();
        let t = takes.last().unwrap();
        let file = format!("{}-{}", g["id"].as_str().unwrap(), t["id"].as_str().unwrap());
        let (take, _) = decode_flac(&std::fs::read(dir.join(format!("{file}.flac"))).unwrap(), t["scale"].as_f64().unwrap_or(1.0) as f32).unwrap();
        let mut mix = vec![0f32; take.len()];
        for s in meta["stems"].as_array().unwrap() {
            let (l, _) = decode_flac(&std::fs::read(dir.join(format!("{}.flac", s["name"].as_str().unwrap()))).unwrap(), s["scale"].as_f64().unwrap_or(1.0) as f32).unwrap();
            for (i, v) in l.iter().enumerate().take(mix.len()) {
                mix[i] += v;
            }
        }
        let first = take.iter().position(|v| v.abs() > 1e-4).unwrap_or(0);
        let last = take.iter().rposition(|v| v.abs() > 1e-4).unwrap_or(0);
        println!("{file}: {} frames, sound from {} ({:.2}s) to {} ({:.2}s)", take.len(), first, first as f64 / 44100.0, last, last as f64 / 44100.0);
        let (from, to) = (first + 44100, last.saturating_sub(44100).max(first + 44100 + 44100));
        let mut best = (0i64, f64::MIN);
        for lag in -2200i64..=2200 {
            let mut dot = 0.0f64;
            for i in from..to.min(take.len()) {
                let j = i as i64 + lag;
                if j >= 0 && (j as usize) < mix.len() {
                    dot += take[i] as f64 * mix[j as usize] as f64;
                }
            }
            if dot > best.1 {
                best = (lag, dot);
            }
        }
        println!("take vs song: best lag {} samples = {:.2} ms", best.0, best.0 as f64 / 44.1);
        assert!(best.0.abs() < 132, "take is {:.1} ms off the song", best.0 as f64 / 44.1);
    }

    /// A stream that reports its device gone is passed on to the webview as a fatal failure, and the engine keeps reporting
    /// load and dropout counts. Silent with a null sink: `PULSE_SINK=natest`.
    #[test]
    #[ignore]
    fn a_lost_device_is_reported() {
        let failures = Arc::new(Mutex::new(Vec::<(bool, String)>::new()));
        let f2 = failures.clone();
        let reports = Arc::new(Mutex::new(Vec::<StateReport>::new()));
        let r2 = reports.clone();
        start_engine(
            Box::new(move |r| r2.lock().unwrap().push(r)),
            Box::new(move |f| f2.lock().unwrap().push((f.fatal, f.message))),
            "ALSA".into(),
            "pulse".into(),
            256,
            true,
            0,
        )
        .expect("start");
        std::thread::sleep(Duration::from_millis(300));
        crate::native_audio::err_fn(cpal::StreamError::DeviceNotAvailable);
        std::thread::sleep(Duration::from_millis(300));
        let last = reports.lock().unwrap().last().cloned().unwrap();
        stop_engine();
        let f = failures.lock().unwrap().clone();
        println!("failures: {f:?}; last report load {:.3} dropouts {}", last.load, last.dropouts);
        assert_eq!(f.len(), 1);
        assert!(f[0].0, "the loss is fatal");
    }
}
