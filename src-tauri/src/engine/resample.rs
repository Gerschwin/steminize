//! Streaming sample-rate conversion for the engine's output, so the audio stream can run at the sound card's own rate
//! while the songs stay at 44.1 kHz. Cubic (Catmull-Rom) interpolation, one block at a time with the fractional position
//! carried between blocks, so any block size gives the same output. A port of `src/player/resample.ts`.

pub struct StreamResampler {
    /// Source frames consumed per output frame.
    ratio: f64,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    /// Valid source frames in buf; index 0 is a history sample, so the cubic can look one back.
    have: usize,
    /// Read position in buf, in source frames.
    phase: f64,
    ended: bool,
}

fn cubic(ym1: f32, y0: f32, y1: f32, y2: f32, t: f32) -> f32 {
    let c1 = 0.5 * (y1 - ym1);
    let c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    let c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
    ((c3 * t + c2) * t + c1) * t + y0
}

impl StreamResampler {
    pub fn new(src_rate: u32, dst_rate: u32) -> Self {
        StreamResampler { ratio: src_rate as f64 / dst_rate as f64, buf_l: vec![0.0; 256], buf_r: vec![0.0; 256], have: 1, phase: 1.0, ended: false }
    }

    /// Forget everything buffered (after a seek, a new song or a restart).
    pub fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.have = 1;
        self.phase = 1.0;
        self.ended = false;
    }

    /// Fills `frames` output frames. `pull(l, r, n)` writes `n` source frames and returns false once the source has run
    /// out (what it wrote is still used). Returns false after the source ended.
    pub fn render(&mut self, mut pull: impl FnMut(&mut [f32], &mut [f32], usize) -> bool, out_l: &mut [f32], out_r: &mut [f32], frames: usize) -> bool {
        let need = (self.phase + frames as f64 * self.ratio).ceil() as usize + 3;
        if need > self.have {
            if need > self.buf_l.len() {
                self.buf_l.resize(need * 2, 0.0);
                self.buf_r.resize(need * 2, 0.0);
            }
            let (have, n) = (self.have, need - self.have);
            if !pull(&mut self.buf_l[have..need], &mut self.buf_r[have..need], n) {
                self.ended = true;
            }
            self.have = need;
        }
        for i in 0..frames {
            let p = self.phase + i as f64 * self.ratio;
            let k = p.floor() as usize;
            let t = (p - k as f64) as f32;
            out_l[i] = cubic(self.buf_l[k - 1], self.buf_l[k], self.buf_l[k + 1], self.buf_l[k + 2], t);
            out_r[i] = cubic(self.buf_r[k - 1], self.buf_r[k], self.buf_r[k + 1], self.buf_r[k + 2], t);
        }
        self.phase += frames as f64 * self.ratio;
        let drop = self.phase.floor() as usize - 1;
        if drop > 0 {
            self.buf_l.copy_within(drop..self.have, 0);
            self.buf_r.copy_within(drop..self.have, 0);
            self.have -= drop;
            self.phase -= drop as f64;
        }
        !self.ended
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(block: usize, total: usize) -> Vec<f32> {
        let mut at = 0usize;
        let mut rs = StreamResampler::new(44100, 48000);
        let mut out = vec![0f32; total];
        let mut o = 0;
        while o < total {
            let n = block.min(total - o);
            let mut scratch = vec![0f32; n];
            rs.render(
                |l, r, k| {
                    for i in 0..k {
                        let v = (2.0 * std::f64::consts::PI * 1000.0 * (at + i) as f64 / 44100.0).sin() as f32;
                        l[i] = v;
                        r[i] = v;
                    }
                    at += k;
                    true
                },
                &mut out[o..o + n],
                &mut scratch,
                n,
            );
            o += n;
        }
        out
    }

    #[test]
    fn a_1khz_sine_at_48khz_matches_the_true_waveform() {
        let a = run(128, 4800);
        let worst = (4..a.len()).map(|i| (a[i] as f64 - (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48000.0).sin()).abs()).fold(0.0, f64::max);
        assert!(worst < 2e-3, "worst error {worst}");
    }

    #[test]
    fn block_size_does_not_change_the_output() {
        let (a, b) = (run(128, 4800), run(37, 4800));
        assert!(a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 1e-6));
    }

    #[test]
    fn reports_when_the_source_has_ended() {
        let mut rs = StreamResampler::new(44100, 48000);
        let (mut l, mut r) = (vec![0.0; 128], vec![0.0; 128]);
        assert!(!rs.render(|a, b, _| (a.fill(0.0), b.fill(0.0), false).2, &mut l, &mut r, 128));
        rs.reset();
        assert!(rs.render(|_, _, _| true, &mut l, &mut r, 64));
    }
}
