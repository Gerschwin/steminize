//! Mixing: sums the stems with per-stem gain, pan and EQ into interleaved stereo, honouring the loop,
//! and mixes the metronome in. A port of `MixSource` in `src/player/mixcore.ts`, which stays the reference.

use super::eq::{EqParams, StemEq};
use std::sync::OnceLock;

pub const SR: f64 = 44100.0;

/// One stem: left and right channels.
pub type Stereo = (Vec<f32>, Vec<f32>);

pub const CLICK_LEN: usize = (0.04 * SR + 0.5) as usize;

fn make_click(freq: f64) -> Vec<f32> {
    (0..CLICK_LEN).map(|i| ((2.0 * std::f64::consts::PI * freq * i as f64 / SR).sin() * (-(i as f64) / 330.0).exp() * 0.6) as f32).collect()
}

/// A short click: 1.5 kHz on bar starts, 1 kHz on other beats.
pub fn clicks() -> &'static (Vec<f32>, Vec<f32>) {
    static C: OnceLock<(Vec<f32>, Vec<f32>)> = OnceLock::new();
    C.get_or_init(|| (make_click(1500.0), make_click(1000.0)))
}

#[derive(Clone, Debug, Default)]
pub struct ClickTrack {
    pub beats: Vec<usize>, // source frames
    pub downbeat: i64,     // index of a bar start in beats
    pub per_bar: i64,
    pub vol: f32,
}

/// Pan law: 0 keeps the stem's original stereo image; moving towards ±1 crossfades to the stem summed to
/// mono and placed with a constant-power pan. Returns [LfromL, LfromR, RfromL, RfromR].
pub fn pan_matrix(pan: f64) -> [f64; 4] {
    let p = pan.clamp(-1.0, 1.0);
    let w = p.abs();
    let theta = (p + 1.0) * std::f64::consts::PI / 4.0;
    let gl = std::f64::consts::SQRT_2 * theta.cos() * 0.5 * w;
    let gr = std::f64::consts::SQRT_2 * theta.sin() * 0.5 * w;
    [1.0 - w + gl, gl, gr, 1.0 - w + gr]
}

pub struct MixSource {
    pub stems: Vec<Stereo>,
    pub gains: Vec<f32>,
    pub pans: Vec<f64>,
    pub end: usize,
    pub pos: usize,
    pub loop_on: bool,
    pub loop_start: usize,
    pub loop_end: usize,
    /// Silent frames emitted after the end (lets the stretcher flush its tail).
    pub pad_end: usize,
    padded: usize,
    /// Metronome mixed into the source, so it is stretched in step with the music.
    pub click: Option<ClickTrack>,
    eqs: Vec<StemEq>,
    tmp_l: Vec<f32>,
    tmp_r: Vec<f32>,
}

impl MixSource {
    pub fn new(stems: Vec<Stereo>, gains: Vec<f32>, end: usize) -> Self {
        MixSource {
            stems,
            gains,
            pans: Vec::new(),
            end,
            pos: 0,
            loop_on: false,
            loop_start: 0,
            loop_end: 0,
            pad_end: 0,
            padded: 0,
            click: None,
            eqs: Vec::new(),
            tmp_l: Vec::new(),
            tmp_r: Vec::new(),
        }
    }

    pub fn reset_pad(&mut self) {
        self.padded = 0;
    }

    pub fn set_eqs(&mut self, params: &[Option<EqParams>]) {
        while self.eqs.len() < params.len() {
            self.eqs.push(StemEq::new(SR));
        }
        for (i, p) in params.iter().enumerate() {
            self.eqs[i].set(*p);
        }
    }

    /// Clear filter memory (after a seek, so old audio doesn't ring on).
    pub fn reset_eqs(&mut self) {
        for e in &mut self.eqs {
            e.reset();
        }
    }

    pub fn looping(&self) -> bool {
        self.loop_on && self.loop_end.saturating_sub(self.loop_start) > 1024
    }

    /// Writes up to `num_frames` interleaved frames into `target`; returns how many were written.
    pub fn extract(&mut self, target: &mut [f32], num_frames: usize) -> usize {
        let mut written = 0;
        while written < num_frames {
            let stop = if self.looping() { self.loop_end } else { self.end };
            if self.pos >= stop {
                if self.looping() {
                    self.pos = self.loop_start;
                    continue;
                }
                let n = (num_frames - written).min(self.pad_end.saturating_sub(self.padded));
                if n == 0 {
                    break;
                }
                target[written * 2..(written + n) * 2].fill(0.0);
                self.padded += n;
                written += n;
                continue;
            }
            let n = (num_frames - written).min(stop - self.pos);
            target[written * 2..(written + n) * 2].fill(0.0);
            for s in 0..self.stems.len() {
                let g = self.gains.get(s).copied().unwrap_or(0.0);
                if g == 0.0 {
                    continue;
                }
                let p0 = self.pos;
                let (stem_l, stem_r) = (&self.stems[s].0, &self.stems[s].1);
                let (l, r, base): (&[f32], &[f32], usize) = match self.eqs.get_mut(s) {
                    Some(eq) if eq.active() => {
                        self.tmp_l.clear();
                        self.tmp_l.extend_from_slice(&stem_l[p0..p0 + n]);
                        self.tmp_r.clear();
                        self.tmp_r.extend_from_slice(&stem_r[p0..p0 + n]);
                        eq.process(&mut self.tmp_l, &mut self.tmp_r);
                        (&self.tmp_l, &self.tmp_r, 0)
                    }
                    _ => (stem_l, stem_r, p0),
                };
                let pan = self.pans.get(s).copied().unwrap_or(0.0);
                let out = &mut target[written * 2..(written + n) * 2];
                if pan == 0.0 {
                    for i in 0..n {
                        out[2 * i] += g * l[base + i];
                        out[2 * i + 1] += g * r[base + i];
                    }
                } else {
                    let [a, b, c, d] = pan_matrix(pan).map(|k| (k * g as f64) as f32);
                    for i in 0..n {
                        out[2 * i] += a * l[base + i] + b * r[base + i];
                        out[2 * i + 1] += c * l[base + i] + d * r[base + i];
                    }
                }
            }
            if self.click.as_ref().map_or(false, |c| c.vol != 0.0) {
                self.add_clicks(target, written, self.pos, n);
            }
            written += n;
            self.pos += n;
        }
        written
    }

    fn add_clicks(&self, target: &mut [f32], offset: usize, pos: usize, n: usize) {
        let c = self.click.as_ref().unwrap();
        let (hi, lo) = clicks();
        // First beat whose click could still be sounding at `pos`.
        let first = c.beats.partition_point(|b| b + CLICK_LEN <= pos);
        for b in first..c.beats.len() {
            if c.beats[b] >= pos + n {
                break;
            }
            let k = ((b as i64 - c.downbeat) % c.per_bar + c.per_bar) % c.per_bar;
            let wave = if k == 0 { hi } else { lo };
            let start = pos.max(c.beats[b]);
            let end = (pos + n).min(c.beats[b] + CLICK_LEN);
            for p in start..end {
                let v = c.vol * wave[p - c.beats[b]];
                let j = (offset + p - pos) * 2;
                target[j] += v;
                target[j + 1] += v;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stem(v: f32, n: usize) -> Stereo {
        (vec![v; n], vec![v; n])
    }

    #[test]
    fn pan_matrix_matches_the_typescript_values() {
        // Values printed by `panMatrix` in src/player/mixcore.ts.
        let close = |a: [f64; 4], b: [f64; 4]| a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-12);
        assert_eq!(pan_matrix(0.0), [1.0, 0.0, 0.0, 1.0]);
        assert!(close(pan_matrix(-1.0), [0.7071067811865476, 0.7071067811865476, 0.0, 0.0]));
        assert!(close(pan_matrix(0.5), [0.6352990250365493, 0.13529902503654928, 0.32664074121909414, 0.8266407412190941]));
    }

    #[test]
    fn sums_stems_with_gains() {
        let mut m = MixSource::new(vec![stem(0.5, 100), stem(0.25, 100)], vec![1.0, 2.0], 100);
        let mut out = vec![0.0; 20];
        assert_eq!(m.extract(&mut out, 10), 10);
        assert!(out.iter().all(|v| (*v - 1.0).abs() < 1e-6));
        assert_eq!(m.pos, 10);
    }

    #[test]
    fn a_muted_stem_is_skipped() {
        let mut m = MixSource::new(vec![stem(0.5, 100), stem(0.25, 100)], vec![0.0, 1.0], 100);
        let mut out = vec![0.0; 4];
        m.extract(&mut out, 2);
        assert!(out.iter().all(|v| (*v - 0.25).abs() < 1e-6));
    }

    #[test]
    fn stops_at_the_end_then_pads_with_silence() {
        let mut m = MixSource::new(vec![stem(1.0, 10)], vec![1.0], 10);
        m.pad_end = 4;
        let mut out = vec![9.0; 40];
        assert_eq!(m.extract(&mut out, 20), 14);
        assert!(out[..20].iter().all(|v| *v == 1.0));
        assert!(out[20..28].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn loops_back_to_the_start() {
        let mut stems = stem(0.0, 4000);
        for (i, v) in stems.0.iter_mut().enumerate() {
            *v = i as f32;
        }
        let mut m = MixSource::new(vec![stems], vec![1.0], 4000);
        m.loop_on = true;
        m.loop_start = 1000;
        m.loop_end = 3000;
        m.pos = 2995;
        let mut out = vec![0.0; 20];
        m.extract(&mut out, 10);
        let left: Vec<f32> = out.chunks(2).map(|f| f[0]).collect();
        assert_eq!(left, vec![2995.0, 2996.0, 2997.0, 2998.0, 2999.0, 1000.0, 1001.0, 1002.0, 1003.0, 1004.0]);
    }

    #[test]
    fn click_lands_on_the_beat_frame() {
        let mut m = MixSource::new(vec![stem(0.0, 1000)], vec![1.0], 1000);
        m.click = Some(ClickTrack { beats: vec![100, 600], downbeat: 0, per_bar: 4, vol: 1.0 });
        let mut out = vec![0.0; 2000];
        m.extract(&mut out, 1000);
        assert_eq!(out[2 * 99], 0.0);
        assert_eq!(out[2 * 100], 0.0); // sin(0) = 0 at the first sample...
        assert!(out[2 * 105].abs() > 0.05); // ...and sounding after it
        assert_eq!(out[2 * 100 + 1], out[2 * 100]);
        assert!(out[2 * 105] > 0.0 && out[2 * 605] != 0.0);
    }

    /// A mix with pan, EQ, gains and a click, rendered in blocks, checked sample by sample against what
    /// `MixSource` in src/player/mixcore.ts produced for the same input (golden values printed from it).
    #[test]
    fn matches_the_typescript_mix_sample_for_sample() {
        const N: usize = 6000;
        let mk = |f1: f64, f2: f64| -> Stereo {
            let mut l = vec![0f32; N];
            let mut r = vec![0f32; N];
            for i in 0..N {
                let x = i as f64;
                l[i] = (0.4 * (x * f1).sin() + 0.2 * (x * f2).sin()) as f32;
                r[i] = (0.3 * (x * f1 * 1.01).sin() - 0.2 * (x * f2).sin()) as f32;
            }
            (l, r)
        };
        let mut m = MixSource::new(vec![mk(0.05, 0.9), mk(0.11, 0.3)], vec![0.8, 0.5], N);
        m.pans = vec![0.5, 0.0];
        m.set_eqs(&[
            Some(EqParams { low_cut: 500.0, high_cut: 0.0, freq: 1000.0, gain: 0.0, q: 1.0 }),
            Some(EqParams { low_cut: 0.0, high_cut: 3000.0, freq: 800.0, gain: 6.0, q: 1.2 }),
        ]);
        m.click = Some(ClickTrack { beats: vec![1000, 2500, 4000], downbeat: 0, per_bar: 4, vol: 0.5 });
        let mut out = vec![0f32; N * 2];
        let mut got = 0;
        for n in [1500, 777, 2000, 1723] {
            got += m.extract(&mut out[got * 2..(got + n) * 2], n);
        }
        assert_eq!(got, N);
        let golden: [(usize, f32, f32); 9] = [
            (0, 0.0, 0.0),
            (1, 0.0679132267832756, -0.04322816804051399),
            (700, 0.5091673731803894, 0.2434399574995041),
            (1000, 0.31340324878692627, -0.35718411207199097),
            (1010, -0.16457206010818481, 0.030015617609024048),
            (2500, -0.3105679750442505, 0.056428488343954086),
            (2511, -0.15784338116645813, 0.6199542284011841),
            (3999, -0.3334830105304718, -0.11491552740335464),
            (5999, -0.0338263064622879, -0.18802663683891296),
        ];
        for (i, l, r) in golden {
            assert!((out[2 * i] - l).abs() < 1e-4 && (out[2 * i + 1] - r).abs() < 1e-4, "frame {i}: got ({}, {}), want ({l}, {r})", out[2 * i], out[2 * i + 1]);
        }
        let sum: f64 = out.iter().map(|v| v.abs() as f64).sum();
        assert!((sum - 2798.2945757962298).abs() < 0.5, "sum {sum}");
    }
}
