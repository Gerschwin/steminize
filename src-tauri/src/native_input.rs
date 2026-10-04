// The native engine's live input: what the sound card's input stream feeds. Monitoring (your instrument mixed into the
// output), the level meter, a rolling snapshot for the tuner and the tab Trainer, and recording a take.
//
// The input and output run as two separate streams with their own callbacks, so the two meet here: the output callback
// writes down where the song was at what time (`note_output`), and a take is placed against that using the round-trip
// delay (output buffers, the card, input buffers) that the loopback test measures.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use crate::native_audio::Ring;

/// Samples kept for the tuner / Trainer (enough for several cycles of a low bass note).
pub const SNAP: usize = 4096;
/// Longest take, in seconds.
pub const MAX_TAKE_SECS: usize = 12 * 60;

pub struct RecState {
    pub samples: Vec<f32>,
    /// Round trip to take off, in seconds.
    pub rt_secs: f64,
    /// Song position (frames) of the first sample, once the first block has arrived.
    pub start_pos: Option<f64>,
}

pub struct InputShared {
    pub t0: Instant,
    pub rate: u32,
    /// An input stream is open.
    pub active: AtomicBool,
    pub monitor: AtomicBool,
    /// Left and right monitor gains (level times the pan law), as f32 bits.
    gain_l: AtomicU32,
    gain_r: AtomicU32,
    ring: Ring,
    chunk: AtomicUsize,
    /// Peak since the last read, as f32 bits.
    level: AtomicU32,
    snap: Mutex<Vec<f32>>,
    pub rec: Mutex<Option<RecState>>,
    // Written by the output callback: where the song was, and when.
    out_time: AtomicU64,
    out_pos: AtomicU64,
    out_rate: AtomicU64,
}

impl InputShared {
    pub fn new(rate: u32) -> Self {
        InputShared {
            t0: Instant::now(),
            rate,
            active: AtomicBool::new(false),
            monitor: AtomicBool::new(false),
            gain_l: AtomicU32::new(0),
            gain_r: AtomicU32::new(0),
            ring: Ring::new(1 << 15),
            chunk: AtomicUsize::new(0),
            level: AtomicU32::new(0),
            snap: Mutex::new(Vec::with_capacity(SNAP * 2)),
            rec: Mutex::new(None),
            out_time: AtomicU64::new(0),
            out_pos: AtomicU64::new(0),
            out_rate: AtomicU64::new(0),
        }
    }

    /// Monitor on / off, with its level and pan. The pan law matches the web player's StereoPanner for a mono source.
    pub fn set_monitor(&self, on: bool, gain: f32, pan: f32) {
        let theta = (pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
        self.gain_l.store((gain * theta.cos()).to_bits(), Ordering::Relaxed);
        self.gain_r.store((gain * theta.sin()).to_bits(), Ordering::Relaxed);
        self.monitor.store(on, Ordering::Relaxed);
    }

    /// Peak since the last call, then reset.
    pub fn take_level(&self) -> f32 {
        f32::from_bits(self.level.swap(0, Ordering::Relaxed))
    }

    pub fn snapshot(&self) -> Vec<f32> {
        self.snap.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// The output callback says where the song is at this moment (`pos` frames at the start of the block it is about to
    /// render) and how fast it is moving (frames per second; 0 when stopped).
    pub fn note_output(&self, pos: f64, frames_per_sec: f64) {
        self.out_time.store(self.t0.elapsed().as_secs_f64().to_bits(), Ordering::Relaxed);
        self.out_pos.store(pos.to_bits(), Ordering::Relaxed);
        self.out_rate.store(frames_per_sec.to_bits(), Ordering::Relaxed);
    }

    /// Where the song was `ago` seconds before `now`, from the last note_output.
    fn song_position_at(&self, t: f64) -> f64 {
        let ot = f64::from_bits(self.out_time.load(Ordering::Relaxed));
        let op = f64::from_bits(self.out_pos.load(Ordering::Relaxed));
        let rate = f64::from_bits(self.out_rate.load(Ordering::Relaxed));
        (op + (t - ot) * rate).max(0.0)
    }

    /// Called from the input callback with the chosen channel as mono.
    pub fn on_input(&self, s: &[f32]) {
        let now = self.t0.elapsed().as_secs_f64();
        self.chunk.store(s.len(), Ordering::Relaxed);
        let peak = s.iter().fold(0f32, |m, v| m.max(v.abs()));
        if peak > f32::from_bits(self.level.load(Ordering::Relaxed)) {
            self.level.store(peak.to_bits(), Ordering::Relaxed);
        }
        // Always queued; the output callback uses it while monitoring and throws it away otherwise, so turning the
        // monitor on never starts with old audio in the queue.
        for v in s {
            self.ring.push(*v);
        }
        if let Ok(mut sn) = self.snap.try_lock() {
            sn.extend_from_slice(s);
            if sn.len() > SNAP {
                let drop = sn.len() - SNAP;
                sn.drain(..drop);
            }
        }
        if let Ok(mut rec) = self.rec.try_lock() {
            if let Some(r) = rec.as_mut() {
                if r.start_pos.is_none() {
                    // The first sample of this block was captured a block ago, and what was being heard then had been
                    // rendered a round trip before that.
                    let tau = now - s.len() as f64 / self.rate as f64 - r.rt_secs;
                    r.start_pos = Some(self.song_position_at(tau));
                }
                if r.samples.len() + s.len() <= r.samples.capacity() {
                    r.samples.extend_from_slice(s);
                }
            }
        }
    }

    /// Called from the output callback: adds the monitored instrument to `l` and `r`. `primed` is the callback's own
    /// state: the two streams use blocks of different sizes and run on their own schedules, so a little is kept in hand
    /// (one output block plus one input block) and the oldest is dropped if far more piles up.
    pub fn mix_into(&self, l: &mut [f32], r: &mut [f32], primed: &mut bool) {
        if !self.active.load(Ordering::Relaxed) {
            return;
        }
        if !self.monitor.load(Ordering::Relaxed) {
            self.ring.skip(self.ring.len());
            *primed = false;
            return;
        }
        let n = l.len();
        let chunk = self.chunk.load(Ordering::Relaxed);
        let mut have = self.ring.len();
        if !*primed {
            if have < n + chunk {
                return;
            }
            *primed = true;
        }
        let keep = n + chunk;
        if have > keep + 2 * n.max(chunk) {
            self.ring.skip(have - keep);
            have = keep;
        }
        let (gl, gr) = (f32::from_bits(self.gain_l.load(Ordering::Relaxed)), f32::from_bits(self.gain_r.load(Ordering::Relaxed)));
        for i in 0..n {
            let v = self.ring.pop().unwrap_or(0.0);
            l[i] += v * gl;
            r[i] += v * gr;
        }
        if have < n {
            *primed = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(v: f32, n: usize) -> Vec<f32> {
        vec![v; n]
    }

    #[test]
    fn monitor_waits_for_a_block_then_plays_what_came_in() {
        let sh = InputShared::new(44100);
        sh.active.store(true, Ordering::Relaxed);
        sh.set_monitor(true, 1.0, 0.0);
        let (mut l, mut r, mut primed) = (vec![0.0; 64], vec![0.0; 64], false);
        sh.on_input(&block(0.5, 50));
        sh.mix_into(&mut l, &mut r, &mut primed);
        assert!(l.iter().all(|v| *v == 0.0), "not enough yet: stays silent rather than glitch");
        sh.on_input(&block(0.5, 50));
        sh.on_input(&block(0.5, 50));
        sh.mix_into(&mut l, &mut r, &mut primed);
        assert!(l.iter().all(|v| (*v - 0.5 * std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-5), "centre pan is -3 dB each side: {}", l[0]);
        assert_eq!(l, r);
    }

    #[test]
    fn hard_pan_puts_the_monitor_in_one_ear() {
        let sh = InputShared::new(44100);
        sh.active.store(true, Ordering::Relaxed);
        sh.set_monitor(true, 1.0, -1.0);
        for _ in 0..4 {
            sh.on_input(&block(1.0, 50));
        }
        let (mut l, mut r, mut primed) = (vec![0.0; 64], vec![0.0; 64], false);
        sh.mix_into(&mut l, &mut r, &mut primed);
        assert!(l.iter().all(|v| (*v - 1.0).abs() < 1e-5) && r.iter().all(|v| v.abs() < 1e-5));
    }

    #[test]
    fn level_is_the_peak_since_the_last_read() {
        let sh = InputShared::new(44100);
        sh.on_input(&[0.1, -0.7, 0.3]);
        assert!((sh.take_level() - 0.7).abs() < 1e-6);
        assert_eq!(sh.take_level(), 0.0);
    }

    #[test]
    fn snapshot_keeps_only_the_latest_samples() {
        let sh = InputShared::new(44100);
        for i in 0..10 {
            sh.on_input(&block(i as f32, 1000));
        }
        let s = sh.snapshot();
        assert_eq!(s.len(), SNAP);
        assert_eq!(*s.last().unwrap(), 9.0);
    }

    #[test]
    fn a_take_starts_a_round_trip_before_where_the_song_was() {
        let sh = InputShared::new(44100);
        // The song was at frame 100000 and moving at normal speed when the output last reported.
        sh.note_output(100000.0, 44100.0);
        let t_out = f64::from_bits(sh.out_time.load(Ordering::Relaxed));
        *sh.rec.lock().unwrap() = Some(RecState { samples: Vec::with_capacity(44100), rt_secs: 0.010, start_pos: None });
        // Pretend the first input block arrives 0.5 s after that report.
        std::thread::sleep(std::time::Duration::from_millis(500));
        sh.on_input(&block(0.1, 441));
        let start = sh.rec.lock().unwrap().as_ref().unwrap().start_pos.unwrap();
        let now = sh.t0.elapsed().as_secs_f64();
        // First sample was captured 10 ms (the block) before "now", and the song position it matches is a round trip (10 ms) earlier still.
        let expect = 100000.0 + (now - 0.010 - 0.010 - t_out) * 44100.0;
        assert!((start - expect).abs() < 44100.0 * 0.003, "start {start}, expected about {expect}");
    }
}
