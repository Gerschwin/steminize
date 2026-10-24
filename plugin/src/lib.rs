//! Steminize Player: plays a Steminize song's stems inside a DAW, in time with the DAW's transport.
//! Licensed GPL-3.0-or-later (see LICENSE): the VST3 bindings the plugin framework uses are GPLv3.

pub mod manifest;
pub mod mix;
pub mod song;

use arc_swap::ArcSwapOption;
use arrayvec::ArrayVec;
use mix::{render, Song, StemSettings, MAX_STEMS};
use nih_plug::prelude::*;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

#[derive(Params)]
struct StemParams {
    #[id = "gain"]
    gain: FloatParam,
    #[id = "mute"]
    mute: BoolParam,
    #[id = "solo"]
    solo: BoolParam,
}

#[derive(Params)]
pub struct PlayerParams {
    /// The level of the main mix output.
    #[id = "master"]
    master: FloatParam,
    /// Shifts the song earlier or later against the DAW's timeline, to nudge it into step.
    #[id = "offset"]
    offset_ms: FloatParam,
    /// Up to eight stems, each with a level, a mute and a solo. The song says which stem is which.
    #[nested(array, group = "Stem")]
    stems: [StemParams; MAX_STEMS],
    /// The folder (or description file) of the song loaded, saved with the DAW project so it comes back.
    #[persist = "song-path"]
    song_path: RwLock<String>,
}

impl Default for PlayerParams {
    fn default() -> Self {
        Self {
            master: FloatParam::new(
                "Master",
                util::db_to_gain(0.0),
                FloatRange::Skewed {
                    min: util::db_to_gain(-40.0),
                    max: util::db_to_gain(6.0),
                    factor: FloatRange::gain_skew_factor(-40.0, 6.0),
                },
            )
            .with_smoother(SmoothingStyle::Logarithmic(30.0))
            .with_unit(" dB")
            .with_value_to_string(formatters::v2s_f32_gain_to_db(1))
            .with_string_to_value(formatters::s2v_f32_gain_to_db()),
            offset_ms: FloatParam::new(
                "Offset",
                0.0,
                FloatRange::Linear {
                    min: -500.0,
                    max: 500.0,
                },
            )
            .with_unit(" ms")
            .with_step_size(0.1),
            stems: std::array::from_fn(|i| StemParams {
                gain: FloatParam::new(
                    format!("Stem {} level", i + 1),
                    util::db_to_gain(0.0),
                    FloatRange::Skewed {
                        min: util::db_to_gain(-40.0),
                        max: util::db_to_gain(6.0),
                        factor: FloatRange::gain_skew_factor(-40.0, 6.0),
                    },
                )
                .with_unit(" dB")
                .with_value_to_string(formatters::v2s_f32_gain_to_db(1))
                .with_string_to_value(formatters::s2v_f32_gain_to_db()),
                mute: BoolParam::new(format!("Stem {} mute", i + 1), false),
                solo: BoolParam::new(format!("Stem {} solo", i + 1), false),
            }),
            song_path: RwLock::new(String::new()),
        }
    }
}

pub struct SteminizePlayer {
    params: Arc<PlayerParams>,
    /// The song being played, swapped in by the loader thread when it has finished reading it.
    song: Arc<ArcSwapOption<Song>>,
    sample_rate: u32,
}

impl Default for SteminizePlayer {
    fn default() -> Self {
        Self {
            params: Arc::new(PlayerParams::default()),
            song: Arc::new(ArcSwapOption::empty()),
            sample_rate: 44100,
        }
    }
}

/// Where a song is remembered between uses when the project has none saved: a line in ~/.config/steminize/plugin-song.txt, or the
/// STEMINIZE_SONG environment variable. (A window to choose a song comes next; this is the way in until then.)
fn fallback_song_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("STEMINIZE_SONG") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p.trim()));
        }
    }
    let home = std::env::var_os("HOME")?;
    let text =
        std::fs::read_to_string(PathBuf::from(home).join(".config/steminize/plugin-song.txt"))
            .ok()?;
    let line = text.lines().next()?.trim().to_string();
    (!line.is_empty()).then(|| PathBuf::from(line))
}

impl SteminizePlayer {
    /// Reads the song on a background thread and swaps it in when ready, so the audio thread never waits for the disk.
    fn start_loading(&self) {
        let chosen = {
            let saved = self
                .params
                .song_path
                .read()
                .map(|s| s.clone())
                .unwrap_or_default();
            if saved.trim().is_empty() {
                fallback_song_path()
            } else {
                Some(PathBuf::from(saved))
            }
        };
        let Some(path) = chosen else { return };
        let slot = self.song.clone();
        let rate = self.sample_rate;
        std::thread::spawn(move || match song::load(&path, rate) {
            Ok(song) => slot.store(Some(Arc::new(song))),
            Err(e) => nih_log!("Steminize Player: {e}"),
        });
    }
}

impl Plugin for SteminizePlayer {
    const NAME: &'static str = "Steminize Player";
    const VENDOR: &'static str = "Steminize";
    const URL: &'static str = "https://github.com/Gerschwin/steminize";
    const EMAIL: &'static str = "";
    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    const AUDIO_IO_LAYOUTS: &'static [AudioIOLayout] = &[AudioIOLayout {
        main_input_channels: None,
        main_output_channels: NonZeroU32::new(2),
        aux_input_ports: &[],
        aux_output_ports: &[new_nonzero_u32(2); MAX_STEMS],
        names: PortNames {
            layout: Some("Mix and stems"),
            main_input: None,
            main_output: Some("Mix"),
            aux_inputs: &[],
            aux_outputs: &[
                "Stem 1", "Stem 2", "Stem 3", "Stem 4", "Stem 5", "Stem 6", "Stem 7", "Stem 8",
            ],
        },
    }];

    const MIDI_INPUT: MidiConfig = MidiConfig::None;
    const MIDI_OUTPUT: MidiConfig = MidiConfig::None;
    const SAMPLE_ACCURATE_AUTOMATION: bool = false;

    type SysExMessage = ();
    type BackgroundTask = ();

    fn params(&self) -> Arc<dyn Params> {
        self.params.clone()
    }

    fn initialize(
        &mut self,
        _layout: &AudioIOLayout,
        config: &BufferConfig,
        _context: &mut impl InitContext<Self>,
    ) -> bool {
        let rate = config.sample_rate.round() as u32;
        // The song is converted to the DAW's rate when it is loaded, so a change of rate means loading it again.
        if rate != self.sample_rate || self.song.load().is_none() {
            self.sample_rate = rate;
            self.start_loading();
        }
        true
    }

    fn reset(&mut self) {}

    fn process(
        &mut self,
        buffer: &mut Buffer,
        aux: &mut AuxiliaryBuffers,
        context: &mut impl ProcessContext<Self>,
    ) -> ProcessStatus {
        let frames = buffer.samples();
        let transport = context.transport();
        let song = self.song.load();
        let playhead = if transport.playing {
            transport.pos_samples()
        } else {
            None
        };
        let (Some(song), Some(pos)) = (song.as_ref(), playhead) else {
            // Stopped, or no song yet, or the host does not say where it is: silence on every output.
            for ch in buffer.as_slice() {
                ch.fill(0.0);
            }
            for out in aux.outputs.iter_mut() {
                for ch in out.as_slice() {
                    ch.fill(0.0);
                }
            }
            return ProcessStatus::Normal;
        };
        let mut settings = [StemSettings::default(); MAX_STEMS];
        for (s, p) in settings.iter_mut().zip(self.params.stems.iter()) {
            *s = StemSettings {
                gain: p.gain.value(),
                mute: p.mute.value(),
                solo: p.solo.value(),
            };
        }
        let master = self.params.master.value();
        let offset = (self.params.offset_ms.value() as f64 * self.sample_rate as f64 / 1000.0)
            .round() as i64;
        let start = pos - song.lead_in as i64 - offset;

        let main = buffer.as_slice();
        let (ml, mr) = main.split_at_mut(1);
        // A fixed-size list, so nothing is allocated in the audio callback.
        let mut stem_bufs: ArrayVec<(&mut [f32], &mut [f32]), MAX_STEMS> = ArrayVec::new();
        for out in aux.outputs.iter_mut().take(MAX_STEMS) {
            let ch = out.as_slice();
            let (a, b) = ch.split_at_mut(1);
            stem_bufs.push((&mut *a[0], &mut *b[0]));
        }
        render(
            song,
            &settings,
            master,
            start,
            frames,
            (&mut *ml[0], &mut *mr[0]),
            &mut stem_bufs,
        );
        ProcessStatus::Normal
    }
}

impl Vst3Plugin for SteminizePlayer {
    const VST3_CLASS_ID: [u8; 16] = *b"SteminizePlayer1";
    const VST3_SUBCATEGORIES: &'static [Vst3SubCategory] =
        &[Vst3SubCategory::Instrument, Vst3SubCategory::Tools];
}

nih_export_vst3!(SteminizePlayer);
