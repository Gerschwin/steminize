//! The heart of the player, with nothing from the plugin framework in it so it can be tested: given where the DAW's playhead is, which
//! sample of each stem sits there, and the mix of them all with each stem's level, mute and solo.
//!
//! The rendering is stateless: every block is worked out from the playhead position alone, so the DAW jumping, looping or scrubbing
//! can never leave the plugin out of step.

pub const MAX_STEMS: usize = 8;

/// One stem, as stereo audio at the rate the DAW is running at.
#[derive(Debug, Default)]
pub struct Stem {
    pub name: String,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// What Steminize had set for this stem: level (linear) and pan (-1 left to 1 right).
    pub base_gain: f32,
    pub pan: f32,
    /// What Steminize had muted or soloed, offered to the window as a starting point (the plugin's own mute and solo are what play).
    pub mute: bool,
    pub solo: bool,
    /// The stem's colour in Steminize, as red, green, blue.
    pub colour: [u8; 3],
}

#[derive(Debug)]
pub struct Song {
    pub title: String,
    pub bpm: f64,
    pub per_bar: u32,
    /// Frames of silence the song starts after on the DAW's timeline.
    pub lead_in: usize,
    pub stems: Vec<Stem>,
    pub markers: Vec<(String, usize)>,
    /// The longest stem, in frames.
    pub len: usize,
}

/// What the player's controls say about one stem.
#[derive(Clone, Copy, Debug)]
pub struct StemSettings {
    pub gain: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Default for StemSettings {
    fn default() -> Self {
        Self {
            gain: 1.0,
            mute: false,
            solo: false,
        }
    }
}

/// Left and right gains for a balance setting: the side you move away from gets quieter, the other stays full.
pub fn balance(pan: f32) -> (f32, f32) {
    let p = pan.clamp(-1.0, 1.0);
    ((1.0 - p.max(0.0)), (1.0 + p.min(0.0)))
}

/// Whether a stem is heard: not muted, and if anything is soloed, soloed.
pub fn audible(settings: &[StemSettings], i: usize) -> bool {
    let any_solo = settings.iter().any(|s| s.solo);
    !settings[i].mute && (!any_solo || settings[i].solo)
}

/// Writes `frames` frames starting at song frame `start` (negative before the song begins, so a lead-in plays as silence).
/// `mix` gets all audible stems added up and scaled by `master`; `stems[i]` gets stem `i` alone with its own level, pan, mute and solo
/// applied. Every buffer is overwritten. Frames past the end of a stem are silence.
pub fn render(
    song: &Song,
    settings: &[StemSettings],
    master: f32,
    start: i64,
    frames: usize,
    mix: (&mut [f32], &mut [f32]),
    stems: &mut [(&mut [f32], &mut [f32])],
) {
    let (ml, mr) = mix;
    ml[..frames].fill(0.0);
    mr[..frames].fill(0.0);
    for (i, out) in stems.iter_mut().enumerate() {
        out.0[..frames].fill(0.0);
        out.1[..frames].fill(0.0);
        let (Some(stem), Some(set)) = (song.stems.get(i), settings.get(i)) else {
            continue;
        };
        if !audible(settings, i) {
            continue;
        }
        let (bl, br) = balance(stem.pan);
        let gl = stem.base_gain * set.gain * bl;
        let gr = stem.base_gain * set.gain * br;
        // The part of this block that lies inside the stem.
        let from = (-start).clamp(0, frames as i64) as usize;
        let upto = ((stem.left.len() as i64 - start).clamp(0, frames as i64)) as usize;
        for n in from..upto {
            let at = (start + n as i64) as usize;
            let l = stem.left[at] * gl;
            let r = stem.right.get(at).copied().unwrap_or(0.0) * gr;
            out.0[n] = l;
            out.1[n] = r;
            ml[n] += l * master;
            mr[n] += r * master;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song() -> Song {
        // Two stems of 10 frames: stem 0 counts 1..=10 on both sides; stem 1 is a constant 0.5 on the left and -0.5 on the right.
        Song {
            title: "t".into(),
            bpm: 120.0,
            per_bar: 4,
            lead_in: 0,
            stems: vec![
                Stem {
                    name: "A".into(),
                    left: (1..=10).map(|x| x as f32).collect(),
                    right: (1..=10).map(|x| x as f32).collect(),
                    base_gain: 1.0,
                    ..Default::default()
                },
                Stem {
                    name: "B".into(),
                    left: vec![0.5; 10],
                    right: vec![-0.5; 10],
                    base_gain: 1.0,
                    ..Default::default()
                },
            ],
            markers: vec![],
            len: 10,
        }
    }

    fn run(
        song: &Song,
        settings: &[StemSettings],
        master: f32,
        start: i64,
        frames: usize,
    ) -> (Vec<f32>, Vec<f32>, Vec<Vec<f32>>) {
        let mut ml = vec![9.0; frames];
        let mut mr = vec![9.0; frames];
        let mut sl: Vec<Vec<f32>> = (0..2).map(|_| vec![9.0; frames]).collect();
        let mut sr: Vec<Vec<f32>> = (0..2).map(|_| vec![9.0; frames]).collect();
        {
            let mut outs: Vec<(&mut [f32], &mut [f32])> = sl
                .iter_mut()
                .zip(sr.iter_mut())
                .map(|(a, b)| (a.as_mut_slice(), b.as_mut_slice()))
                .collect();
            render(
                song,
                settings,
                master,
                start,
                frames,
                (&mut ml, &mut mr),
                &mut outs,
            );
        }
        (ml, mr, sl)
    }

    #[test]
    fn plays_each_stem_at_the_playhead_and_sums_them() {
        let s = song();
        let set = [StemSettings::default(); 2];
        let (ml, mr, st) = run(&s, &set, 1.0, 2, 4);
        assert_eq!(st[0], vec![3.0, 4.0, 5.0, 6.0]);
        assert_eq!(ml, vec![3.5, 4.5, 5.5, 6.5]);
        assert_eq!(mr, vec![2.5, 3.5, 4.5, 5.5]);
    }

    #[test]
    fn before_the_song_and_after_its_end_is_silence_and_the_block_straddling_the_start_lines_up() {
        let s = song();
        let set = [StemSettings::default(); 2];
        let (ml, _, st) = run(&s, &set, 1.0, -2, 5);
        assert_eq!(st[0], vec![0.0, 0.0, 1.0, 2.0, 3.0]);
        assert_eq!(ml[0], 0.0);
        let (_, _, st2) = run(&s, &set, 1.0, 8, 5);
        assert_eq!(st2[0], vec![9.0, 10.0, 0.0, 0.0, 0.0]);
        let (ml3, _, _) = run(&s, &set, 1.0, 100, 3);
        assert_eq!(ml3, vec![0.0; 3]);
    }

    #[test]
    fn mute_and_solo_decide_what_is_heard() {
        let s = song();
        let mut set = [StemSettings::default(); 2];
        set[0].mute = true;
        let (ml, _, st) = run(&s, &set, 1.0, 0, 2);
        assert_eq!(st[0], vec![0.0, 0.0], "a muted stem's own output is silent");
        assert_eq!(ml, vec![0.5, 0.5]);
        set[0].mute = false;
        set[1].solo = true;
        let (ml, _, st) = run(&s, &set, 1.0, 0, 2);
        assert_eq!(
            st[0],
            vec![0.0, 0.0],
            "with a solo on, the others are silent"
        );
        assert_eq!(ml, vec![0.5, 0.5]);
        set[0].solo = true;
        let (ml, _, _) = run(&s, &set, 1.0, 0, 1);
        assert_eq!(ml, vec![1.5], "two solos are both heard");
        set[1].mute = true;
        let (ml, _, _) = run(&s, &set, 1.0, 0, 1);
        assert_eq!(ml, vec![1.0], "mute beats solo");
    }

    #[test]
    fn levels_and_master_scale_the_mix_but_the_stem_outputs_ignore_the_master() {
        let s = song();
        let set = [
            StemSettings {
                gain: 0.5,
                mute: false,
                solo: false,
            },
            StemSettings::default(),
        ];
        let (ml, _, st) = run(&s, &set, 2.0, 0, 1);
        assert_eq!(st[0], vec![0.5]);
        assert_eq!(ml, vec![(0.5 + 0.5) * 2.0]);
    }

    #[test]
    fn pan_is_a_balance_and_steminizes_own_level_and_pan_are_applied() {
        assert_eq!(balance(0.0), (1.0, 1.0));
        assert_eq!(balance(-0.5), (1.0, 0.5));
        assert_eq!(balance(1.0), (0.0, 1.0));
        assert_eq!(balance(5.0), (0.0, 1.0));
        let mut s = song();
        s.stems[0].base_gain = 0.8;
        s.stems[0].pan = 0.5;
        let set = [StemSettings::default(); 2];
        let (_, _, st) = run(&s, &set, 1.0, 0, 1);
        assert!(
            (st[0][0] - 1.0 * 0.8 * 0.5).abs() < 1e-6,
            "pan right halves the left"
        );
    }

    #[test]
    fn the_same_position_always_gives_the_same_audio_so_jumps_and_loops_cannot_drift() {
        let s = song();
        let set = [StemSettings::default(); 2];
        let (a, _, _) = run(&s, &set, 1.0, 3, 4);
        let _ = run(&s, &set, 1.0, 7, 3);
        let (b, _, _) = run(&s, &set, 1.0, 3, 4);
        assert_eq!(a, b);
    }

    #[test]
    fn stems_of_different_lengths_and_a_missing_right_channel_do_not_panic() {
        let mut s = song();
        s.stems[1].right.truncate(3);
        let set = [StemSettings::default(); 2];
        let (_, mr, _) = run(&s, &set, 1.0, 0, 10);
        assert_eq!(mr.len(), 10);
        assert_eq!(mr[5], 6.0); // the short right channel counts as silence there; stem 0's right is 6.0
    }
}
