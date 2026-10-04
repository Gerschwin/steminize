//! Playback sequencing on top of the Renderer: loop passes, a pause between passes (gap + count-in), and the
//! speed trainer. A port of `src/player/transport.ts`, which stays the reference.

use super::mix::{clicks, ClickTrack, CLICK_LEN, SR};
use super::renderer::Renderer;

#[derive(Clone, Debug)]
pub struct Trainer {
    pub on: bool,
    pub from: f64,  // tempo ratio, e.g. 0.7
    pub to: f64,    // e.g. 1
    pub step: f64,  // e.g. 0.05
    pub every: u32, // passes per step
    /// Set (a fraction, e.g. 0.9) when the UI decides each step from how well the pass was played rather than
    /// this stepping every `every` passes. 0 = the plain speed trainer.
    pub gate: f64,
}

#[derive(Clone, Debug)]
pub struct Practice {
    pub gap: f64,       // seconds of silence between loop passes
    pub count_in: bool, // one bar of clicks before each pass / before play
    pub per_bar: i64,
    pub beats: Vec<usize>, // source frames (empty = tempo unknown)
    pub downbeat: i64,
    pub click: bool,
    pub click_vol: f32,
    pub trainer: Trainer,
}

impl Default for Practice {
    fn default() -> Self {
        Practice {
            gap: 0.0,
            count_in: false,
            per_bar: 4,
            beats: Vec::new(),
            downbeat: 0,
            click: false,
            click_vol: 0.5,
            trainer: Trainer { on: false, from: 0.7, to: 1.0, step: 0.05, every: 1, gate: 0.0 },
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LoopState {
    pub on: bool,
    pub start: usize,
    pub end: usize,
}

pub struct Transport {
    pub r: Renderer,
    pub loop_: LoopState,
    pub p: Practice,
    /// Completed loop passes (reported so the UI can show trainer progress).
    pub passes: u32,
    pause_left: usize,
    pause_len: usize,
    pause_clicks: Vec<(usize, bool)>, // (frame into the pause, accent)
    length: usize,
}

impl Transport {
    pub fn new(r: Renderer) -> Self {
        let length = r.src.end;
        Transport { r, loop_: LoopState::default(), p: Practice::default(), passes: 0, pause_left: 0, pause_len: 0, pause_clicks: Vec::new(), length }
    }

    pub fn looping(&self) -> bool {
        self.loop_.on && self.loop_.end.saturating_sub(self.loop_.start) > 1024
    }

    pub fn pausing(&self) -> bool {
        self.pause_left > 0
    }

    pub fn set_loop(&mut self, on: bool, start: usize, end: usize) {
        self.loop_ = LoopState { on, start, end };
        self.r.src.loop_on = false; // passes are sequenced here instead
        self.r.src.end = if self.looping() { self.loop_.end } else { self.length };
        if !self.looping() {
            self.pause_left = 0;
        }
        if self.looping() && (self.r.heard < self.loop_.start as f64 || self.r.heard >= self.loop_.end as f64) {
            self.r.seek(self.loop_.start as f64);
        }
        self.passes = 0;
    }

    pub fn set_practice(&mut self, p: Practice) {
        let trainer_started = p.trainer.on && !self.p.trainer.on;
        self.r.src.click = if p.click && !p.beats.is_empty() {
            Some(ClickTrack { beats: p.beats.clone(), downbeat: p.downbeat, per_bar: p.per_bar, vol: p.click_vol })
        } else {
            None
        };
        let (count_in, gap) = (p.count_in, p.gap);
        let (from, to) = (p.trainer.from, p.trainer.to);
        let _ = to;
        self.p = p;
        if trainer_started {
            self.passes = 0;
            let pitch = self.r.pitch;
            self.r.set_tempo_pitch(from, pitch);
            if self.looping() {
                self.r.seek(self.loop_.start as f64);
            }
        }
        if !count_in && gap == 0.0 {
            self.pause_left = 0;
        }
    }

    pub fn seek(&mut self, pos: f64) {
        self.pause_left = 0;
        let pos = if self.looping() { pos.max(self.loop_.start as f64).min(self.loop_.end as f64 - 1.0) } else { pos };
        self.r.seek(pos);
    }

    /// Called when playback starts: count in if asked to.
    pub fn on_play(&mut self) {
        if self.r.heard >= self.length as f64 - 128.0 {
            let to = if self.looping() { self.loop_.start as f64 } else { 0.0 };
            self.r.seek(to);
        }
        if self.looping() && (self.r.heard < self.loop_.start as f64 || self.r.heard >= self.loop_.end as f64) {
            self.r.seek(self.loop_.start as f64);
        }
        if self.p.count_in {
            self.begin_pause(0.0);
        }
    }

    /// Beat length (source frames) around a position, from the detected beats.
    fn local_period(&self, pos: f64) -> f64 {
        let b = &self.p.beats;
        if b.len() < 3 {
            return 0.0;
        }
        let i = b.iter().position(|x| *x as f64 >= pos).unwrap_or(b.len() - 1);
        let lo = i.saturating_sub(4).max(1);
        let hi = (i + 4).min(b.len() - 1);
        let mut d: Vec<f64> = (lo..=hi).map(|k| b[k] as f64 - b[k - 1] as f64).collect();
        d.sort_by(|x, y| x.partial_cmp(y).unwrap());
        d[d.len() >> 1]
    }

    fn begin_pause(&mut self, gap_seconds: f64) {
        let gap = (gap_seconds * SR).round() as usize;
        let mut clicks_at = Vec::new();
        let mut len = gap;
        let period = if self.p.count_in { self.local_period(self.r.heard) / self.r.tempo } else { 0.0 };
        if period > 0.0 {
            for k in 0..self.p.per_bar {
                clicks_at.push((gap + (k as f64 * period).round() as usize, k == 0));
            }
            len = gap + (self.p.per_bar as f64 * period).round() as usize;
        }
        self.pause_len = len;
        self.pause_left = len;
        self.pause_clicks = clicks_at;
    }

    fn end_pass(&mut self) {
        self.passes += 1;
        let t = self.p.trainer.clone();
        if t.on && t.gate == 0.0 && self.passes % t.every.max(1) == 0 {
            let next = t.to.min(((self.r.tempo + t.step) * 100.0).round() / 100.0);
            if next != self.r.tempo {
                let pitch = self.r.pitch;
                self.r.set_tempo_pitch(next, pitch);
            }
        }
        self.r.seek(self.loop_.start as f64);
        let gap = self.p.gap;
        self.begin_pause(gap);
    }

    /// Fill `n` output frames. Returns false when the track has ended.
    pub fn render(&mut self, l: &mut [f32], r: &mut [f32], n: usize) -> bool {
        let (hi, lo) = clicks();
        let mut i = 0;
        while i < n {
            if self.pause_left > 0 {
                let k = (n - i).min(self.pause_left);
                l[i..i + k].fill(0.0);
                r[i..i + k].fill(0.0);
                let t0 = self.pause_len - self.pause_left; // frames into the pause
                for &(at, accent) in &self.pause_clicks {
                    let wave = if accent { hi } else { lo };
                    let from = t0.max(at);
                    let to = (t0 + k).min(at + CLICK_LEN);
                    if from < to {
                        let vol = self.p.click_vol.max(0.3);
                        for t in from..to {
                            let v = wave[t - at] * vol;
                            l[i + t - t0] += v;
                            r[i + t - t0] += v;
                        }
                    }
                }
                self.pause_left -= k;
                i += k;
                continue;
            }
            if self.looping() {
                let remain = self.loop_.end as f64 - self.r.heard;
                if remain <= 0.5 {
                    self.end_pass();
                    continue;
                }
                let want = (n - i).min(((remain / self.r.tempo).ceil() as usize).max(1));
                let got = self.r.render(&mut l[i..], &mut r[i..], want);
                i += got;
                if got == 0 {
                    self.end_pass();
                }
                continue;
            }
            let got = self.r.render(&mut l[i..], &mut r[i..], n - i);
            if got < n - i {
                l[i + got..n].fill(0.0);
                r[i + got..n].fill(0.0);
                return false;
            }
            i += got;
        }
        true
    }
}

/// After a loop pass, whether a *gated* speed trainer steps up: only once `every` passes in a row have been played at
/// `gate` accuracy or better. A pass in which nothing was judged neither counts towards that nor spoils the run.
pub fn gate_step(clean: u32, hit: u32, total: u32, gate: f64, every: u32) -> (u32, bool) {
    if total == 0 {
        return (clean, false);
    }
    if (hit as f64 / total as f64) < gate {
        return (0, false);
    }
    let next = clean + 1;
    if next >= every.max(1) {
        (0, true)
    } else {
        (next, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::mix::{MixSource, Stereo};

    fn transport(len: usize) -> Transport {
        let st: Stereo = (vec![0.25; len], vec![0.25; len]);
        let mut src = MixSource::new(vec![st], vec![1.0], len);
        src.pad_end = 0;
        Transport::new(Renderer::new(src))
    }

    fn render(t: &mut Transport, frames: usize) -> (Vec<f32>, bool) {
        let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
        let ok = t.render(&mut l, &mut r, frames);
        (l, ok)
    }

    #[test]
    fn plays_to_the_end_then_reports_it() {
        let mut t = transport(1000);
        let (l, ok) = render(&mut t, 600);
        assert!(ok && l.iter().all(|v| *v == 0.25));
        let (l, ok) = render(&mut t, 600);
        assert!(!ok);
        assert!(l[..400].iter().all(|v| *v == 0.25) && l[400..].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_loop_restarts_and_counts_passes() {
        let mut t = transport(10000);
        t.set_loop(true, 2000, 4000);
        assert_eq!(t.r.heard, 2000.0);
        let (_, ok) = render(&mut t, 5000);
        assert!(ok);
        assert_eq!(t.passes, 2);
    }

    #[test]
    fn a_gap_between_passes_is_silent() {
        let mut t = transport(10000);
        t.set_loop(true, 2000, 4000);
        t.set_practice(Practice { gap: 0.01, ..Practice::default() }); // 441 frames
        let (l, _) = render(&mut t, 2441);
        assert!(l[..2000].iter().all(|v| *v == 0.25));
        assert!(l[2000..2441].iter().all(|v| *v == 0.0), "gap should be silent");
    }

    #[test]
    fn the_speed_trainer_steps_up_after_each_pass_to_its_target() {
        let mut t = transport(200000);
        t.set_loop(true, 1000, 3000);
        t.set_practice(Practice { trainer: Trainer { on: true, from: 0.8, to: 0.9, step: 0.05, every: 1, gate: 0.0 }, ..Practice::default() });
        assert_eq!(t.r.tempo, 0.8);
        // Enough output for several passes at the slow speeds.
        for _ in 0..40 {
            render(&mut t, 1000);
        }
        assert!(t.passes >= 2);
        assert_eq!(t.r.tempo, 0.9, "stops at the target");
    }

    #[test]
    fn a_gated_trainer_never_steps_on_its_own() {
        let mut t = transport(200000);
        t.set_loop(true, 1000, 3000);
        t.set_practice(Practice { trainer: Trainer { on: true, from: 0.8, to: 1.0, step: 0.05, every: 1, gate: 0.9 }, ..Practice::default() });
        for _ in 0..40 {
            render(&mut t, 1000);
        }
        assert_eq!(t.r.tempo, 0.8);
    }

    #[test]
    fn gate_step_needs_enough_clean_passes_in_a_row() {
        assert_eq!(gate_step(0, 9, 10, 0.9, 2), (1, false));
        assert_eq!(gate_step(1, 9, 10, 0.9, 2), (0, true));
        assert_eq!(gate_step(1, 5, 10, 0.9, 2), (0, false));
        assert_eq!(gate_step(1, 0, 0, 0.9, 2), (1, false));
    }

    #[test]
    fn a_count_in_pauses_before_play_with_clicks() {
        let mut t = transport(100000);
        let beats: Vec<usize> = (0..20).map(|i| 1000 + i * 2000).collect();
        t.set_practice(Practice { count_in: true, per_bar: 4, beats, click: false, ..Practice::default() });
        t.seek(1000.0);
        t.on_play();
        assert!(t.pausing());
        let (l, _) = render(&mut t, 8000);
        assert!(l[..100].iter().any(|v| v.abs() > 0.0), "first click sounds at once");
        assert!(!t.pausing());
        assert_eq!(t.r.heard, 1000.0, "the song has not started yet");
    }
}
