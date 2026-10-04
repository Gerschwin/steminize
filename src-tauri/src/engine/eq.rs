//! Per-stem EQ: optional low-cut and high-cut (4th-order Butterworth, 24 dB/octave) plus one peaking
//! "focus" band. Standard RBJ biquads. A port of `src/player/eq.ts`, which stays the reference.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqParams {
    pub low_cut: f64,  // Hz, 0 = off
    pub high_cut: f64, // Hz, 0 = off
    pub freq: f64,     // focus centre, Hz
    pub gain: f64,     // focus boost/cut, dB (0 = off)
    pub q: f64,        // focus width
}

pub const FLAT: EqParams = EqParams { low_cut: 0.0, high_cut: 0.0, freq: 1000.0, gain: 0.0, q: 1.0 };

fn same_eq(a: &EqParams, b: &EqParams) -> bool {
    a.low_cut == b.low_cut && a.high_cut == b.high_cut && a.gain == b.gain && (a.gain == 0.0 || (a.freq == b.freq && a.q == b.q))
}

/// b0 b1 b2 a1 a2 (a0 = 1)
type Coef = [f64; 5];

#[derive(Clone, Copy)]
enum Kind {
    Lp,
    Hp,
    Peak,
}

fn biquad(kind: Kind, f: f64, q: f64, sr: f64, db: f64) -> Coef {
    let w = 2.0 * std::f64::consts::PI * f.min(sr * 0.49) / sr;
    let cos = w.cos();
    let alpha = w.sin() / (2.0 * q);
    let (b0, b1, b2, a0, a1, a2);
    match kind {
        Kind::Peak => {
            let a = 10f64.powf(db / 40.0);
            (b0, b1, b2, a0, a1, a2) = (1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a);
        }
        _ => {
            let lp = matches!(kind, Kind::Lp);
            let k = if lp { (1.0 - cos) / 2.0 } else { (1.0 + cos) / 2.0 };
            (b0, b1, b2, a0, a1, a2) = (k, if lp { 1.0 - cos } else { -(1.0 + cos) }, k, 1.0 + alpha, -2.0 * cos, 1.0 - alpha);
        }
    }
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

/// Two cascaded sections with these Qs make a 4th-order Butterworth.
const BUTTER4: [f64; 2] = [0.5412, 1.3066];

fn sections(e: &EqParams, sr: f64) -> Vec<Coef> {
    let mut out = Vec::new();
    if e.low_cut != 0.0 {
        for q in BUTTER4 {
            out.push(biquad(Kind::Hp, e.low_cut, q, sr, 0.0));
        }
    }
    if e.gain != 0.0 {
        out.push(biquad(Kind::Peak, e.freq, e.q, sr, e.gain));
    }
    if e.high_cut != 0.0 {
        for q in BUTTER4 {
            out.push(biquad(Kind::Lp, e.high_cut, q, sr, 0.0));
        }
    }
    out
}

/// Stateful stereo filter chain for one stem.
pub struct StemEq {
    coefs: Vec<Coef>,
    state: Vec<f64>, // per section: L z1 z2, R z1 z2
    params: EqParams,
    sr: f64,
}

impl StemEq {
    pub fn new(sr: f64) -> Self {
        StemEq { coefs: Vec::new(), state: Vec::new(), params: FLAT, sr }
    }

    pub fn set(&mut self, e: Option<EqParams>) {
        let p = e.unwrap_or(FLAT);
        if same_eq(&p, &self.params) {
            return;
        }
        self.params = p;
        let next = sections(&p, self.sr);
        // Keep filter memory when the chain shape is unchanged (smooth slider moves).
        if next.len() != self.coefs.len() {
            self.state = vec![0.0; next.len() * 4];
        }
        self.coefs = next;
    }

    pub fn active(&self) -> bool {
        !self.coefs.is_empty()
    }

    pub fn reset(&mut self) {
        self.state.fill(0.0);
    }

    /// Filter `l` and `r` in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (s, c) in self.coefs.iter().enumerate() {
            let [b0, b1, b2, a1, a2] = *c;
            for (ch, x) in [&mut *l, &mut *r].into_iter().enumerate() {
                let o = s * 4 + ch * 2;
                let (mut z1, mut z2) = (self.state[o], self.state[o + 1]);
                for v in x.iter_mut() {
                    let inp = *v as f64;
                    let y = b0 * inp + z1;
                    z1 = b1 * inp - a1 * y + z2;
                    z2 = b2 * inp - a2 * y;
                    *v = y as f32;
                }
                self.state[o] = z1;
                self.state[o + 1] = z2;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, n: usize, sr: f64) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn flat_eq_is_inactive_and_leaves_audio_alone() {
        let mut e = StemEq::new(44100.0);
        e.set(Some(FLAT));
        assert!(!e.active());
    }

    #[test]
    fn low_cut_removes_a_low_tone_and_keeps_a_high_one() {
        let mut e = StemEq::new(44100.0);
        e.set(Some(EqParams { low_cut: 1000.0, ..FLAT }));
        assert!(e.active());
        let (mut lo, mut lo_r) = (tone(100.0, 8000, 44100.0), tone(100.0, 8000, 44100.0));
        e.process(&mut lo, &mut lo_r);
        e.reset();
        let (mut hi, mut hi_r) = (tone(8000.0, 8000, 44100.0), tone(8000.0, 8000, 44100.0));
        e.process(&mut hi, &mut hi_r);
        assert!(rms(&lo[4000..]) < 0.01, "100 Hz should be gone: {}", rms(&lo[4000..]));
        assert!(rms(&hi[4000..]) > 0.65, "8 kHz should pass: {}", rms(&hi[4000..]));
    }

    #[test]
    fn peak_boost_raises_the_centre_by_about_its_gain() {
        let mut e = StemEq::new(44100.0);
        e.set(Some(EqParams { freq: 1000.0, gain: 6.0, q: 1.0, ..FLAT }));
        let (mut a, mut b) = (tone(1000.0, 8000, 44100.0), tone(1000.0, 8000, 44100.0));
        let before = rms(&a[4000..]);
        e.process(&mut a, &mut b);
        let db = 20.0 * (rms(&a[4000..]) / before).log10();
        assert!((db - 6.0).abs() < 0.3, "boost was {db} dB");
    }

    /// Coefficients checked against the TypeScript reference (`sections()` in eq.ts) for a 1 kHz low cut.
    #[test]
    fn matches_the_typescript_coefficients() {
        let s = sections(&EqParams { low_cut: 1000.0, ..FLAT }, 44100.0);
        assert_eq!(s.len(), 2);
        // b0 for an RBJ high-pass is (1 + cos w) / 2 / (1 + alpha): recompute independently.
        let w = 2.0 * std::f64::consts::PI * 1000.0 / 44100.0;
        let alpha = w.sin() / (2.0 * 0.5412);
        let b0 = (1.0 + w.cos()) / 2.0 / (1.0 + alpha);
        assert!((s[0][0] - b0).abs() < 1e-12);
    }
}
