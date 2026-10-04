//! Turns the mix into audio at a chosen tempo and pitch. At normal speed it passes straight through; otherwise
//! it runs the Signalsmith stretcher (MIT licensed). A port of `Renderer` in `src/player/mixcore.ts`,
//! with that library standing in for SoundTouch.

use super::mix::MixSource;
use signalsmith_stretch::Stretch;

pub struct Renderer {
    pub src: MixSource,
    st: Stretch,
    tmp: Vec<f32>,
    feed: Vec<f32>,
    out: Vec<f32>,
    pub tempo: f64,
    pub pitch: f64,
    /// Source position (frames) most recently fed to the output. With the stretcher running the sound lags this by the
    /// stretcher's latency; `audible()` is where the sound actually is.
    pub heard: f64,
    /// Where the last seek landed: the sound can't be before it, however far back the stretcher's latency would put it.
    seek_pos: f64,
    /// Fraction of an input frame owed between blocks, so the tempo stays exact over many blocks.
    carry: f64,
}

impl Renderer {
    pub fn new(src: MixSource) -> Self {
        Renderer { src, st: Stretch::preset_default(2, 44100), tmp: Vec::new(), feed: Vec::new(), out: Vec::new(), tempo: 1.0, pitch: 0.0, heard: 0.0, seek_pos: 0.0, carry: 0.0 }
    }

    pub fn bypass(&self) -> bool {
        self.tempo == 1.0 && self.pitch == 0.0
    }

    /// Where in the song the sound being heard is. At normal speed that is `heard`. With the stretcher running, what it
    /// outputs comes from audio it was fed a little earlier (its input latency), so the sound is behind `heard` by that much.
    pub fn audible(&self) -> f64 {
        if self.bypass() {
            self.heard
        } else {
            (self.heard - self.st.input_latency() as f64).max(self.seek_pos).min(self.heard)
        }
    }

    pub fn seek(&mut self, pos: f64) {
        // Positions must be whole frames: they index the sample arrays.
        self.src.pos = (pos.round().max(0.0) as usize).min(self.src.end);
        self.heard = self.src.pos as f64;
        self.seek_pos = self.heard;
        self.src.reset_pad();
        self.src.reset_eqs();
        self.st.reset();
        self.carry = 0.0;
    }

    pub fn set_tempo_pitch(&mut self, tempo: f64, pitch: f64) {
        let was_bypass = self.bypass();
        self.tempo = tempo;
        self.pitch = pitch;
        self.st.set_transpose_factor_semitones(pitch as f32, None);
        if was_bypass != self.bypass() {
            self.seek(self.heard);
        }
    }

    /// Fills planar output; returns frames produced (fewer at the end of the track).
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32], frames: usize) -> usize {
        if self.tmp.len() < frames * 2 {
            self.tmp.resize(frames * 2, 0.0);
        }
        let n;
        if self.bypass() {
            let mut t = std::mem::take(&mut self.tmp);
            n = self.src.extract(&mut t, frames);
            self.heard = self.src.pos as f64;
            self.tmp = t;
        } else {
            // The stretcher takes `frames * tempo` input frames and gives `frames` back, so the input fed per
            // block follows the tempo; the fraction left over is carried to the next block.
            let want = frames as f64 * self.tempo + self.carry;
            let take = want.floor() as usize;
            self.carry = want - take as f64;
            if self.feed.len() < take * 2 {
                self.feed.resize(take * 2, 0.0);
            }
            if self.out.len() < frames * 2 {
                self.out.resize(frames * 2, 0.0);
            }
            let mut feed = std::mem::take(&mut self.feed);
            let got = self.src.extract(&mut feed, take);
            feed[got * 2..take * 2].fill(0.0);
            self.st.process(&feed[..take * 2], &mut self.out[..frames * 2]);
            self.feed = feed;
            // At the end fewer input frames were real, so fewer output frames are.
            n = if got == take { frames } else { ((got as f64 / self.tempo).round() as usize).min(frames) };
            self.tmp[..n * 2].copy_from_slice(&self.out[..n * 2]);
            self.heard += got as f64;
            if self.src.looping() && self.heard >= self.src.loop_end as f64 {
                let len = (self.src.loop_end - self.src.loop_start) as f64;
                self.heard = self.src.loop_start as f64 + (self.heard - self.src.loop_end as f64) % len;
            }
            self.heard = self.heard.min(self.src.end as f64);
        }
        for i in 0..n {
            out_l[i] = self.tmp[2 * i];
            out_r[i] = self.tmp[2 * i + 1];
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::mix::Stereo;

    fn sine_stem(freq: f64, n: usize) -> Stereo {
        let v: Vec<f32> = (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / 44100.0).sin() as f32 * 0.5).collect();
        (v.clone(), v)
    }

    fn render_all(r: &mut Renderer, frames: usize, block: usize) -> Vec<f32> {
        let (mut l, mut rr) = (vec![0.0; block], vec![0.0; block]);
        let mut out = Vec::new();
        while out.len() < frames {
            let n = r.render(&mut l, &mut rr, block.min(frames - out.len()));
            if n == 0 {
                break;
            }
            out.extend_from_slice(&l[..n]);
        }
        out
    }

    #[test]
    fn normal_speed_passes_the_mix_straight_through() {
        let mut r = Renderer::new(MixSource::new(vec![sine_stem(440.0, 20000)], vec![1.0], 20000));
        let out = render_all(&mut r, 5000, 128);
        let expect: Vec<f32> = sine_stem(440.0, 5000).0;
        assert_eq!(out.len(), 5000);
        assert!(out.iter().zip(&expect).all(|(a, b)| (a - b).abs() < 1e-6));
        assert_eq!(r.heard, 5000.0);
    }

    #[test]
    fn half_speed_advances_the_source_half_as_fast() {
        let mut src = MixSource::new(vec![sine_stem(440.0, 200000)], vec![1.0], 200000);
        src.pad_end = 32768;
        let mut r = Renderer::new(src);
        r.set_tempo_pitch(0.5, 0.0);
        let out = render_all(&mut r, 44100, 256);
        assert_eq!(out.len(), 44100);
        assert!((r.heard - 22050.0).abs() < 2.0, "heard {}", r.heard);
    }

    #[test]
    fn the_sound_is_behind_the_fed_position_only_while_stretching() {
        let mut src = MixSource::new(vec![sine_stem(440.0, 200000)], vec![1.0], 200000);
        src.pad_end = 32768;
        let mut r = Renderer::new(src);
        render_all(&mut r, 5000, 256);
        assert_eq!(r.audible(), r.heard, "normal speed: nothing to correct");
        r.seek(50000.0);
        r.set_tempo_pitch(0.75, 0.0);
        assert_eq!(r.audible(), 50000.0, "right after a seek the sound is at the seek position");
        render_all(&mut r, 20000, 256);
        let behind = r.heard - r.audible();
        println!("stretcher latency: {behind} frames = {:.1} ms", behind / 44.1);
        assert!(behind > 100.0 && behind < 8000.0, "sound should trail the fed position by the stretcher's latency: {behind}");
    }

    #[test]
    fn half_speed_keeps_the_pitch() {
        let mut src = MixSource::new(vec![sine_stem(440.0, 200000)], vec![1.0], 200000);
        src.pad_end = 32768;
        let mut r = Renderer::new(src);
        r.set_tempo_pitch(0.5, 0.0);
        let out = render_all(&mut r, 44100, 256);
        // Count upward zero crossings in the settled part: a 440 Hz tone has ~440 per second.
        let tail = &out[10000..10000 + 22050];
        let crossings = tail.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as f64 - 220.0).abs() < 6.0, "{crossings} crossings in half a second");
    }

    #[test]
    fn a_pitch_shift_of_an_octave_doubles_the_frequency() {
        let mut src = MixSource::new(vec![sine_stem(440.0, 200000)], vec![1.0], 200000);
        src.pad_end = 32768;
        let mut r = Renderer::new(src);
        r.set_tempo_pitch(1.0, 12.0);
        let out = render_all(&mut r, 44100, 256);
        let tail = &out[10000..10000 + 22050];
        let crossings = tail.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as f64 - 440.0).abs() < 12.0, "{crossings} crossings in half a second");
    }

    #[test]
    fn the_end_of_the_track_returns_a_short_block() {
        let mut src = MixSource::new(vec![sine_stem(440.0, 1000)], vec![1.0], 1000);
        src.pad_end = 0;
        let mut r = Renderer::new(src);
        let (mut l, mut rr) = (vec![0.0; 600], vec![0.0; 600]);
        assert_eq!(r.render(&mut l, &mut rr, 600), 600);
        assert_eq!(r.render(&mut l, &mut rr, 600), 400);
        assert_eq!(r.render(&mut l, &mut rr, 600), 0);
    }
}
