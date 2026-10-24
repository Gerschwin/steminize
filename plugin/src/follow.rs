//! Following the DAW's tempo and a key shift. The song is laid on the DAW's timeline by *beats*: a moment `b` beats into the song plays when
//! the DAW's playhead is `b` beats past the song's start, whatever the DAW's tempo is, so changing the DAW's tempo (or automating it)
//! slows or speeds the song and keeps its beats on the DAW's beats. Away from the song's own tempo (or with a key shift) the audio goes
//! through a time-stretcher (Signalsmith Stretch, MIT) so the pitch does not change with the speed.
//!
//! Two things make this fiddly, and both were measured (see the tests):
//! * the stretcher delays its output by about 120 ms, and how much depends on the speed. Reporting that as latency would delay the song
//!   (and, in some DAWs, everything you monitor) by that much, so instead the audio is fed that far *ahead*, and the sound comes out on
//!   the beat;
//! * after a start or a jump the stretcher fades its output in over about 35 ms. That would soften the first beat, so for those first
//!   milliseconds the unstretched audio is cross-faded in.
//! A song at exactly the DAW's tempo with no key shift skips all this and is copied straight through.

use crate::mix::{audible, balance, Song, StemSettings, MAX_STEMS};
use signalsmith_stretch::Stretch;

/// How the DAW's playhead relates to the song for one block.
#[derive(Clone, Copy, Debug)]
pub struct Block {
    /// The song frame that should sound at the first output frame, with no speed change applied to the position (so: the exact place).
    pub target: f64,
    /// Song frames per output frame: the DAW's tempo over the song's. 1.0 is the song's own speed.
    pub speed: f64,
    /// Key shift in semitones.
    pub pitch: f64,
    pub frames: usize,
}

/// After a start or jump, this many output frames cross-fade from the unstretched audio to the stretched.
const BRIDGE: usize = 2048;
/// A difference between where we are and where the DAW says we should be, in source frames, beyond which we jump instead of steering.
const JUMP: f64 = 0.020;
/// Dead band: errors smaller than this (seconds) are left alone.
const SLACK: f64 = 0.0005;

struct Lane {
    st: Stretch,
}

pub struct Follower {
    rate: u32,
    lanes: Vec<Lane>,
    /// The next source frame to feed the stretchers (the "head"), and the fraction owed between blocks.
    head: f64,
    carry: f64,
    /// Output frames since the last resync, for the cross-fade.
    since: usize,
    /// In stretch mode (as opposed to straight through), and in direct mode the next frame expected.
    stretching: bool,
    next_direct: f64,
    active: bool,
    pitch: f64,
    /// Scratch space, sized once so nothing is allocated while playing.
    feed: Vec<f32>,
    out: Vec<f32>,
}

impl Follower {
    pub fn new(rate: u32, max_frames: usize) -> Self {
        let lanes = (0..MAX_STEMS)
            .map(|_| Lane {
                st: Stretch::preset_default(2, rate),
            })
            .collect();
        // Up to 4x the speed means 4x the input frames.
        Follower {
            rate,
            lanes,
            head: 0.0,
            carry: 0.0,
            since: 0,
            stretching: false,
            next_direct: 0.0,
            active: false,
            pitch: 0.0,
            feed: vec![0.0; (max_frames * 4).max(32768) * 2],
            out: vec![0.0; max_frames * 2],
        }
    }

    /// The playhead is not moving: the next block starts afresh.
    pub fn stop(&mut self) {
        self.active = false;
    }

    /// How far ahead of the wanted position the stretchers have to be fed, in source frames, so the output is on time.
    fn lead(&self, speed: f64) -> f64 {
        let l = &self.lanes[0].st;
        l.input_latency() as f64 + (l.output_latency() as f64 * speed).ceil()
    }

    fn at(song: &Song, stem: usize, i: i64, ch: usize) -> f32 {
        let s = &song.stems[stem];
        let v = if ch == 0 { &s.left } else { &s.right };
        if i < 0 {
            0.0
        } else {
            v.get(i as usize).copied().unwrap_or(0.0)
        }
    }

    /// Cubic (Catmull-Rom) read of a stem at a fractional frame.
    fn read(song: &Song, stem: usize, pos: f64, ch: usize) -> f32 {
        let i = pos.floor() as i64;
        let t = (pos - i as f64) as f32;
        let (p0, p1, p2, p3) = (
            Self::at(song, stem, i - 1, ch),
            Self::at(song, stem, i, ch),
            Self::at(song, stem, i + 1, ch),
            Self::at(song, stem, i + 2, ch),
        );
        0.5 * ((2.0 * p1)
            + (-p0 + p2) * t
            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t
            + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t)
    }

    fn resync(&mut self, song: &Song, b: &Block) {
        let speed = b.speed;
        let lead = self.lead(speed);
        let start = b.target.round() as i64;
        let head = start + lead as i64;
        for (i, lane) in self.lanes.iter_mut().enumerate() {
            lane.st.reset();
            lane.st.set_transpose_factor_semitones(b.pitch as f32, None);
            if i < song.stems.len() {
                let n = lead as usize;
                let buf = &mut self.feed[..n * 2];
                for k in 0..n {
                    let pos = start + k as i64;
                    buf[2 * k] = Self::at(song, i, pos, 0);
                    buf[2 * k + 1] = Self::at(song, i, pos, 1);
                }
                lane.st.seek(&buf[..], speed);
            }
        }
        self.head = head as f64;
        self.carry = 0.0;
        self.since = 0;
        self.pitch = b.pitch;
    }

    /// Fills the mix and stem buffers for this block, as `mix::render` does but following the DAW's tempo and the key shift.
    pub fn render(
        &mut self,
        song: &Song,
        settings: &[StemSettings],
        master: f32,
        b: Block,
        mix: (&mut [f32], &mut [f32]),
        stems: &mut [(&mut [f32], &mut [f32])],
    ) {
        let frames = b.frames.min(self.out.len() / 2);
        let neutral = (b.speed - 1.0).abs() < 1e-5 && b.pitch.abs() < 1e-6;
        if neutral {
            self.render_direct(song, settings, master, &b, frames, mix, stems);
        } else {
            self.render_stretched(song, settings, master, &b, frames, mix, stems);
        }
    }

    fn render_direct(
        &mut self,
        song: &Song,
        settings: &[StemSettings],
        master: f32,
        b: &Block,
        frames: usize,
        mix: (&mut [f32], &mut [f32]),
        stems: &mut [(&mut [f32], &mut [f32])],
    ) {
        // Straight through. Stay on the frame we expected unless the DAW has moved us (a jump or a drift past a couple of frames).
        if self.stretching || !self.active || (b.target - self.next_direct).abs() > 2.0 {
            self.next_direct = b.target.round();
        }
        self.stretching = false;
        self.active = true;
        crate::mix::render(
            song,
            settings,
            master,
            self.next_direct as i64,
            frames,
            mix,
            stems,
        );
        self.next_direct += frames as f64;
    }

    fn render_stretched(
        &mut self,
        song: &Song,
        settings: &[StemSettings],
        master: f32,
        b: &Block,
        frames: usize,
        mix: (&mut [f32], &mut [f32]),
        stems: &mut [(&mut [f32], &mut [f32])],
    ) {
        let speed = b.speed.clamp(0.25, 4.0);
        // Where the sound now being made came from, against where the DAW says it should be: the error, in source frames.
        let expected = self.head - self.lead(speed);
        let err = b.target - expected;
        let jump = !self.active || !self.stretching || err.abs() > JUMP * self.rate as f64;
        if jump {
            let blk = Block { speed, ..*b };
            self.resync(song, &blk);
        }
        self.active = true;
        self.stretching = true;
        if (b.pitch - self.pitch).abs() > 1e-6 {
            for lane in self.lanes.iter_mut() {
                lane.st.set_transpose_factor_semitones(b.pitch as f32, None);
            }
            self.pitch = b.pitch;
        }
        // Small errors are steered out gently: this block takes a little more or less input.
        let steer = if jump {
            0.0
        } else if err.abs() < SLACK * self.rate as f64 {
            0.0
        } else {
            (err * 0.1).clamp(-(frames as f64) * 0.1 * speed, frames as f64 * 0.1 * speed)
        };
        let want = frames as f64 * speed + self.carry + steer;
        let take = want.floor().max(0.0) as usize;
        self.carry = want - take as f64;
        let start = self.head.round() as i64;
        let n_out = frames;
        debug_assert!(take * 2 <= self.feed.len());
        let take = take.min(self.feed.len() / 2);
        let (ml, mr) = mix;
        ml[..n_out].fill(0.0);
        mr[..n_out].fill(0.0);
        let bridging = self.since < BRIDGE;
        let since = self.since;
        for (si, out) in stems.iter_mut().enumerate() {
            out.0[..n_out].fill(0.0);
            out.1[..n_out].fill(0.0);
            if si >= song.stems.len() {
                continue;
            }
            let lane = &mut self.lanes[si];
            for k in 0..take {
                let pos = start + k as i64;
                self.feed[2 * k] = Self::at(song, si, pos, 0);
                self.feed[2 * k + 1] = Self::at(song, si, pos, 1);
            }
            lane.st
                .process(&self.feed[..take * 2], &mut self.out[..n_out * 2]);
            if !audible(settings, si) {
                continue;
            }
            let stem = &song.stems[si];
            let (bl, br) = balance(stem.pan);
            let g = stem.base_gain * settings[si].gain;
            for k in 0..n_out {
                let (mut l, mut r) = (self.out[2 * k], self.out[2 * k + 1]);
                if bridging && since + k < BRIDGE {
                    let w = ((since + k) as f32 / BRIDGE as f32).clamp(0.0, 1.0);
                    let w = w * w * (3.0 - 2.0 * w);
                    // The unstretched audio for the same moment: what the stretcher has not yet faded in to.
                    let pos = b.target + k as f64 * speed;
                    l += Self::read(song, si, pos, 0) * (1.0 - w);
                    r += Self::read(song, si, pos, 1) * (1.0 - w);
                }
                let (l, r) = (l * g * bl, r * g * br);
                out.0[k] = l;
                out.1[k] = r;
                ml[k] += l * master;
                mr[k] += r * master;
            }
        }
        self.head += take as f64;
        self.since += n_out;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mix::Stem;

    const RATE: u32 = 44100;

    fn song_with(left: Vec<f32>) -> Song {
        let len = left.len();
        Song {
            title: "t".into(),
            bpm: 120.0,
            per_bar: 4,
            lead_in: 0,
            stems: vec![Stem {
                name: "a".into(),
                right: left.clone(),
                left,
                base_gain: 1.0,
                pan: 0.0,
            }],
            markers: vec![],
            len,
        }
    }

    fn click_song(at: usize, len: usize) -> Song {
        let mut v = vec![0.0f32; len];
        // A short burst rather than a single sample, which any filter would smear to nothing.
        for k in 0..8 {
            v[at + k] = 0.8;
        }
        song_with(v)
    }

    /// Plays blocks of 256 from `target0` at `speed` for `blocks` blocks and returns all the output of the one stem.
    fn play(
        f: &mut Follower,
        song: &Song,
        target0: f64,
        speed: f64,
        pitch: f64,
        blocks: usize,
    ) -> Vec<f32> {
        let settings = [StemSettings::default(); MAX_STEMS];
        let mut all = Vec::new();
        for n in 0..blocks {
            let (mut ml, mut mr) = (vec![0.0f32; 256], vec![0.0f32; 256]);
            let mut sl: Vec<Vec<f32>> = (0..MAX_STEMS).map(|_| vec![0.0; 256]).collect();
            let mut sr: Vec<Vec<f32>> = (0..MAX_STEMS).map(|_| vec![0.0; 256]).collect();
            {
                let mut bufs: Vec<(&mut [f32], &mut [f32])> = sl
                    .iter_mut()
                    .zip(sr.iter_mut())
                    .map(|(a, b)| (a.as_mut_slice(), b.as_mut_slice()))
                    .collect();
                f.render(
                    song,
                    &settings,
                    1.0,
                    Block {
                        target: target0 + (n * 256) as f64 * speed,
                        speed,
                        pitch,
                        frames: 256,
                    },
                    (&mut ml, &mut mr),
                    &mut bufs,
                );
            }
            all.extend_from_slice(&ml);
        }
        all
    }

    fn peak_at(out: &[f32]) -> usize {
        out.iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().partial_cmp(&b.1.abs()).unwrap())
            .unwrap()
            .0
    }

    #[test]
    fn click_lands_on_time_at_every_speed() {
        for &speed in &[0.5, 0.8, 1.0, 1.25, 1.5, 2.0] {
            let click = 30000usize;
            let song = click_song(click, 120_000);
            let mut f = Follower::new(RATE, 256);
            let target0 = 10000.0;
            let out = play(&mut f, &song, target0, speed, 0.0, 400);
            let want = (click as f64 - target0) / speed + 4.0 / speed;
            let got = peak_at(&out) as f64;
            // Within 3 ms.
            assert!(
                (got - want).abs() < 130.0,
                "speed {speed}: click at {got}, wanted {want}"
            );
        }
    }

    #[test]
    fn straight_through_at_the_songs_own_speed() {
        let song = click_song(5000, 20000);
        let mut f = Follower::new(RATE, 256);
        let out = play(&mut f, &song, 4000.0, 1.0, 0.0, 10);
        assert!((1000..=1007).contains(&peak_at(&out)));
    }

    #[test]
    fn a_jump_resynchronises() {
        let click = 90000usize;
        let song = click_song(click, 200_000);
        let mut f = Follower::new(RATE, 256);
        // Play somewhere else for a while at 0.8, then jump to just before the click.
        let _ = play(&mut f, &song, 20000.0, 0.8, 0.0, 20);
        let target0 = 85000.0;
        let out = play(&mut f, &song, target0, 0.8, 0.0, 120);
        let want = (click as f64 - target0) / 0.8 + 4.0 / 0.8;
        let got = peak_at(&out) as f64;
        assert!((got - want).abs() < 130.0, "click at {got}, wanted {want}");
    }

    #[test]
    fn a_key_shift_changes_the_pitch_and_not_the_speed() {
        let sine: Vec<f32> = (0..200_000)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin() * 0.5)
            .collect();
        let song = song_with(sine);
        let crossings = |pitch: f64| {
            let mut f = Follower::new(RATE, 256);
            let out = play(&mut f, &song, 10000.0, 1.0, pitch, 300);
            let seg = &out[20000..60000];
            seg.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() as f64
                / (seg.len() as f64 / RATE as f64)
        };
        let base = crossings(0.0);
        let up = crossings(12.0);
        assert!((base - 440.0).abs() < 12.0, "base {base}");
        assert!((up - 880.0).abs() < 25.0, "octave up {up}");
    }

    #[test]
    fn follows_a_changing_tempo_without_drifting() {
        // A click every 0.5 s; the speed ramps from 0.8 to 1.2 over the run. Each click must land where the ramp says it should.
        let step = 22050usize;
        let mut v = vec![0.0f32; step * 40];
        let clicks: Vec<usize> = (1..30).map(|k| k * step).collect();
        for &c in &clicks {
            for k in 0..8 {
                v[c + k] = 0.8;
            }
        }
        let song = song_with(v);
        let mut f = Follower::new(RATE, 256);
        let settings = [StemSettings::default(); MAX_STEMS];
        let blocks = 1500;
        let mut target = 3000.0;
        let mut out = Vec::new();
        let mut map: Vec<(f64, usize)> = Vec::new(); // song position of each output frame, at block starts
        for n in 0..blocks {
            let speed = 0.8 + 0.4 * n as f64 / blocks as f64;
            let (mut ml, mut mr) = (vec![0.0f32; 256], vec![0.0f32; 256]);
            let mut sl: Vec<Vec<f32>> = (0..MAX_STEMS).map(|_| vec![0.0; 256]).collect();
            let mut sr: Vec<Vec<f32>> = (0..MAX_STEMS).map(|_| vec![0.0; 256]).collect();
            {
                let mut bufs: Vec<(&mut [f32], &mut [f32])> = sl
                    .iter_mut()
                    .zip(sr.iter_mut())
                    .map(|(a, b)| (a.as_mut_slice(), b.as_mut_slice()))
                    .collect();
                f.render(
                    &song,
                    &settings,
                    1.0,
                    Block {
                        target,
                        speed,
                        pitch: 0.0,
                        frames: 256,
                    },
                    (&mut ml, &mut mr),
                    &mut bufs,
                );
            }
            map.push((target, n * 256));
            target += 256.0 * speed;
            out.extend_from_slice(&ml);
        }
        // For each click find the output frame where the song position equals it, and compare with the loudest sample nearby.
        let mut checked = 0;
        for &c in &clicks {
            let Some(w) = map
                .windows(2)
                .find(|w| w[0].0 <= c as f64 && (c as f64) < w[1].0)
            else {
                continue;
            };
            let frac = (c as f64 - w[0].0) / (w[1].0 - w[0].0);
            let want = w[0].1 as f64 + frac * 256.0;
            if want < 6000.0 || want + 300.0 > out.len() as f64 {
                continue;
            }
            let lo = (want as usize).saturating_sub(300);
            let seg = &out[lo..want as usize + 300];
            let got = (lo + peak_at(seg)) as f64;
            assert!(
                (got - want - 4.0).abs() < 90.0,
                "click {c}: at {got}, wanted {want}"
            );
            checked += 1;
        }
        assert!(checked >= 15, "only {checked} clicks checked");
    }
}
