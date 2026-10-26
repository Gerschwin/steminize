// Native audio through JACK as a single stream (desktop app, optional).
//
// The ordinary native path opens the sound card's input and output as two separate streams with their own callbacks, so the
// monitored instrument has to wait in a queue between them (about a block and a half). JACK calls one function per period
// with this period's input and wants this period's output, so the instrument goes straight through: no queue, and the song,
// click and monitor are all in step with the card.
//
// libjack is loaded when needed, not linked, so the app starts on a machine without JACK. It needs a JACK server to talk to: jackd,
// or PipeWire with its JACK support (the pipewire-jack package), which is what most desktop Linux systems have.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use jack::{AudioIn, AudioOut, Client, ClientOptions, Control, LatencyType, PortFlags, ProcessScope};

use crate::native_playback::Engine;

/// The name this audio system has in the list of hosts.
pub const JACK_HOST: &str = "JACK (one stream)";

fn open_client(name: &str) -> Result<Client, String> {
    Client::new(name, ClientOptions::NO_START_SERVER).map(|(c, _)| c).map_err(|e| format!("No JACK server to talk to ({e}). Start jackd, or on PipeWire make sure its JACK support is installed (the pipewire-jack package)."))
}

const AUDIO: &str = "32 bit float mono audio";

/// The part of a port's name before the colon: the device or program that owns it.
fn owner(port: &str) -> &str {
    port.split(':').next().unwrap_or(port)
}

/// Orders a device's ports left to right by the channel name at the end (FL, FR / AUX0, AUX1 / 1, 2).
fn by_channel(ports: &mut [String]) {
    ports.sort_by_key(|p| p.rsplit(|c| c == '_' || c == ':').next().unwrap_or("").to_string());
}

/// The engine's own client. JACK normally renames a client whose name is taken (Steminize-01), and the port names used here would then
/// point at somebody else's ports, so insist on the exact name and say so when something else (another Steminize) already has it.
fn open_engine_client() -> Result<Client, String> {
    Client::new("Steminize", ClientOptions::NO_START_SERVER | ClientOptions::USE_EXACT_NAME)
        .map(|(c, _)| c)
        .map_err(|e| format!("Couldn't open the JACK client \"Steminize\" ({e}). Is another copy of Steminize already using JACK? If not, make sure JACK (or PipeWire's JACK support) is running."))
}

/// What the device list shows for JACK: each capture port as an input (named as JACK names it) and each owner of playback ports as an
/// output. Empty when there is no JACK server, or libjack is not installed.
pub fn devices() -> Vec<(String, bool, u32, u32)> {
    let Ok(client) = open_client("Steminize-scan") else {
        return Vec::new();
    };
    let rate = client.sample_rate() as u32;
    let buffer = client.buffer_size();
    let mut out: Vec<(String, bool, u32, u32)> = Vec::new();
    for p in client.ports(None, Some(AUDIO), PortFlags::IS_PHYSICAL | PortFlags::IS_INPUT) {
        let o = owner(&p).to_string();
        if !out.iter().any(|(n, input, _, _)| !*input && *n == o) {
            out.push((o, false, rate, buffer));
        }
    }
    for p in client.ports(None, Some(AUDIO), PortFlags::IS_PHYSICAL | PortFlags::IS_OUTPUT) {
        out.push((p, true, rate, buffer));
    }
    out
}

/// The JACK process callback: one input, two outputs, and the same engine the other path runs.
struct Process {
    input: jack::Port<AudioIn>,
    out_l: jack::Port<AudioOut>,
    out_r: jack::Port<AudioOut>,
    engine: Engine,
    mono: Vec<f32>,
    l: Vec<f32>,
    r: Vec<f32>,
}

impl jack::ProcessHandler for Process {
    fn process(&mut self, _: &Client, ps: &ProcessScope) -> Control {
        let n = ps.n_frames() as usize;
        if self.l.len() < n {
            self.mono.resize(n, 0.0);
            self.l.resize(n, 0.0);
            self.r.resize(n, 0.0);
        }
        self.mono[..n].copy_from_slice(self.input.as_slice(ps));
        self.engine.fill_duplex(&self.mono[..n], &mut self.l[..n], &mut self.r[..n]);
        self.out_l.as_mut_slice(ps).copy_from_slice(&self.l[..n]);
        self.out_r.as_mut_slice(ps).copy_from_slice(&self.r[..n]);
        Control::Continue
    }
}

/// Tells the app when JACK goes away or glitches.
struct Notify {
    xruns: Arc<AtomicU32>,
    on_failure: Box<dyn Fn(String) + Send + Sync>,
}

impl jack::NotificationHandler for Notify {
    fn xrun(&mut self, _: &Client) -> Control {
        self.xruns.fetch_add(1, Ordering::Relaxed);
        Control::Continue
    }
    unsafe fn shutdown(&mut self, _: jack::ClientStatus, reason: &str) {
        (self.on_failure)(format!("JACK stopped: {reason}"));
    }
}

/// A running JACK client. Dropping it closes the client.
pub struct JackRun {
    client: jack::AsyncClient<Notify, Process>,
    pub xruns: Arc<AtomicU32>,
    pub rate: u32,
    pub period: u32,
}

impl JackRun {
    /// Connects the engine's outputs to the first two playback ports of `device` (a name from the output list; empty means the first
    /// device there is). One port gets both sides.
    fn connect_outputs(&self, device: &str) -> Result<(), String> {
        let c = self.client.as_client();
        let all = c.ports(None, Some(AUDIO), PortFlags::IS_PHYSICAL | PortFlags::IS_INPUT);
        let device = if device.is_empty() { all.first().map(|p| owner(p).to_string()).unwrap_or_default() } else { device.to_string() };
        let mut ports: Vec<String> = all.into_iter().filter(|p| owner(p) == device).collect();
        if ports.is_empty() {
            return Err(format!("JACK has no playback device called {device}"));
        }
        by_channel(&mut ports);
        let (left, right) = (ports[0].clone(), ports.get(1).unwrap_or(&ports[0]).clone());
        c.connect_ports_by_name("Steminize:out_l", &left).map_err(|e| format!("Couldn't connect to {left}: {e}"))?;
        c.connect_ports_by_name("Steminize:out_r", &right).map_err(|e| format!("Couldn't connect to {right}: {e}"))?;
        Ok(())
    }

    /// Connects the instrument input to a capture port (by JACK's name for it; empty means the first one). Returns a description.
    pub fn connect_input(&self, port: &str) -> Result<String, String> {
        let c = self.client.as_client();
        let capture = c.ports(None, Some(AUDIO), PortFlags::IS_PHYSICAL | PortFlags::IS_OUTPUT);
        // The name may be one JACK knows, or a device name left over from another audio system: take the capture port that contains it.
        let wanted = port.to_lowercase();
        let chosen = if port.is_empty() {
            capture.first().cloned()
        } else {
            capture.iter().find(|p| p.as_str() == port).or_else(|| capture.iter().find(|p| p.to_lowercase().contains(&wanted))).cloned()
        };
        let chosen = chosen.ok_or_else(|| format!("JACK has no input called {port}. Its inputs are: {}", capture.join(", ")))?;
        // Only one instrument at a time.
        if let Some(mine) = c.port_by_name("Steminize:in") {
            let _ = c.disconnect(&mine);
        }
        c.connect_ports_by_name(&chosen, "Steminize:in").map_err(|e| format!("Couldn't connect {chosen}: {e}"))?;
        Ok(format!("{chosen} through JACK, no queue between input and output"))
    }

    /// Asks the JACK server for a different period (frames per cycle). The engine carries on: its callback takes whatever size arrives.
    /// Returns the period now in force, which the server may have kept different from the one asked for.
    pub fn set_buffer_size(&self, frames: u32) -> Result<u32, String> {
        let c = self.client.as_client();
        c.set_buffer_size(frames).map_err(|e| format!("JACK would not change the buffer size to {frames}: {e}"))?;
        // The change takes a moment to reach the client.
        std::thread::sleep(std::time::Duration::from_millis(150));
        Ok(c.buffer_size())
    }

    pub fn disconnect_input(&self) {
        let c = self.client.as_client();
        if let Some(mine) = c.port_by_name("Steminize:in") {
            let _ = c.disconnect(&mine);
        }
    }

    /// The round trip JACK reports for the card: frames from the instrument reaching the input to the song-side output reaching
    /// the speakers, in milliseconds. Zero when nothing is connected to report on.
    pub fn refresh_reported_latency(&self) {
        RT_US.store((self.reported_round_trip_ms() * 1000.0) as u32, Ordering::Relaxed);
    }

    fn reported_round_trip_ms(&self) -> f64 {
        let c = self.client.as_client();
        let capture = c.port_by_name("Steminize:in").map(|p| p.get_latency_range(LatencyType::Capture).1).unwrap_or(0);
        let playback = c.port_by_name("Steminize:out_l").map(|p| p.get_latency_range(LatencyType::Playback).1).unwrap_or(0);
        (capture + playback) as f64 * 1000.0 / self.rate as f64
    }
}

/// Opens the JACK client and starts it running `engine`'s audio. The engine is built by `make` for JACK's sample rate.
pub fn start(output: &str, buffer: u32, make: impl FnOnce(u32) -> Engine, on_failure: Box<dyn Fn(String) + Send + Sync>) -> Result<JackRun, String> {
    // PipeWire's JACK library takes the period a client would like from this variable (jackd ignores it: its server sets the period).
    if buffer > 0 {
        std::env::set_var("PIPEWIRE_LATENCY", format!("{buffer}/48000"));
    }
    let client = open_engine_client()?;
    let rate = client.sample_rate() as u32;
    let period = client.buffer_size();
    let input = client.register_port("in", AudioIn::default()).map_err(|e| e.to_string())?;
    let out_l = client.register_port("out_l", AudioOut::default()).map_err(|e| e.to_string())?;
    let out_r = client.register_port("out_r", AudioOut::default()).map_err(|e| e.to_string())?;
    let size = period.max(4096) as usize;
    let xruns = Arc::new(AtomicU32::new(0));
    let process = Process { input, out_l, out_r, engine: make(rate), mono: vec![0.0; size], l: vec![0.0; size], r: vec![0.0; size] };
    let client = client.activate_async(Notify { xruns: xruns.clone(), on_failure }, process).map_err(|e| e.to_string())?;
    RT_US.store(0, Ordering::Relaxed);
    RUNNING.store(true, Ordering::Relaxed);
    let run = JackRun { client, xruns, rate, period };
    run.connect_outputs(output)?;
    Ok(run)
}

// What the tests need to know about the running client without reaching into the engine's thread.
static RT_US: AtomicU32 = AtomicU32::new(0);
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the engine is running through JACK.
pub fn running() -> bool {
    RUNNING.load(Ordering::Relaxed)
}

impl Drop for JackRun {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Relaxed);
    }
}


/// The round trip JACK last reported for the engine's ports, in milliseconds (0 when not in JACK mode or nothing is connected).
pub fn reported_ms() -> f64 {
    RT_US.load(Ordering::Relaxed) as f64 / 1000.0
}
