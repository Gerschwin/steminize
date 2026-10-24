//! Steminize Player: plays a Steminize song's stems inside a DAW, in time with the DAW's transport.
//! Licensed GPL-3.0-or-later (see LICENSE): the VST3 bindings the plugin framework uses are GPLv3.

pub mod editor;
pub mod follow;
pub mod manifest;
pub mod mix;
pub mod song;

use arc_swap::ArcSwapOption;
use arrayvec::ArrayVec;
use follow::{Block, Follower};
use mix::{Song, StemSettings, MAX_STEMS};
use nih_plug::prelude::*;
use nih_plug_egui::EguiState;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, RwLock};

#[derive(Params)]
pub struct StemParams {
    #[id = "gain"]
    pub gain: FloatParam,
    #[id = "mute"]
    pub mute: BoolParam,
    #[id = "solo"]
    pub solo: BoolParam,
}

#[derive(Params)]
pub struct PlayerParams {
    /// The level of the main mix output.
    #[id = "master"]
    pub master: FloatParam,
    /// Shifts the song earlier or later against the DAW's timeline, to nudge it into step.
    #[id = "offset"]
    pub offset_ms: FloatParam,
    /// Whether the song speeds up and slows down with the DAW's tempo (keeping its pitch). Off plays it at its own speed.
    #[id = "follow"]
    pub follow_tempo: BoolParam,
    /// Shifts the song's key, in semitones, without changing its speed.
    #[id = "pitch"]
    pub pitch: IntParam,
    /// Up to eight stems, each with a level, a mute and a solo. The song says which stem is which.
    #[nested(array, group = "Stem")]
    pub stems: [StemParams; MAX_STEMS],
    /// The folder (or description file) of the song loaded, saved with the DAW project so it comes back.
    #[persist = "song-path"]
    pub song_path: RwLock<String>,
    #[persist = "editor-state"]
    editor_state: Arc<EguiState>,
}

impl PlayerParams {
    pub fn editor_state_arc(&self) -> Arc<EguiState> {
        self.editor_state.clone()
    }
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
            follow_tempo: BoolParam::new("Follow tempo", true),
            pitch: IntParam::new("Key shift", 0, IntRange::Linear { min: -12, max: 12 })
                .with_unit(" st"),
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
            editor_state: EguiState::from_size(editor::WIDTH, editor::HEIGHT),
        }
    }
}

/// How the last block was played, for the window to show.
pub const MODE_IDLE: u8 = 0;
pub const MODE_STRAIGHT: u8 = 1;
pub const MODE_STRETCH: u8 = 2;
pub const MODE_OWN_SPEED: u8 = 3;

/// What the audio thread, the loader thread and the window share. The audio thread only ever reads `song` and writes the plain numbers.
pub struct Shared {
    /// The song being played, swapped in by the loader thread when it has finished reading it.
    pub song: ArcSwapOption<Song>,
    pub rate: AtomicU32,
    pub host_tempo: AtomicU64,
    pub speed: AtomicU64,
    pub mode: AtomicU8,
    /// A message for the window (a load that failed), empty when all is well.
    pub status: Mutex<String>,
    pub loading: AtomicBool,
    /// Set when a song has just been loaded from the window, so the window applies the song's mute and solo.
    pub apply_song_mix: AtomicBool,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            song: ArcSwapOption::empty(),
            rate: AtomicU32::new(44100),
            host_tempo: AtomicU64::new(0f64.to_bits()),
            speed: AtomicU64::new(1f64.to_bits()),
            mode: AtomicU8::new(MODE_IDLE),
            status: Mutex::new(String::new()),
            loading: AtomicBool::new(false),
            apply_song_mix: AtomicBool::new(false),
        }
    }
}

/// Reads the song on a background thread and swaps it in when ready, so the audio thread never waits for the disk.
pub fn spawn_load(shared: &Arc<Shared>, path: PathBuf, from_window: bool) {
    let shared = shared.clone();
    shared.loading.store(true, Ordering::Release);
    if let Ok(mut s) = shared.status.lock() {
        s.clear();
    }
    std::thread::spawn(move || {
        let rate = shared.rate.load(Ordering::Acquire);
        match song::load(&path, rate) {
            Ok(song) => {
                shared.song.store(Some(Arc::new(song)));
                if from_window {
                    shared.apply_song_mix.store(true, Ordering::Release);
                }
            }
            Err(e) => {
                nih_log!("Steminize Player: {e}");
                if let Ok(mut s) = shared.status.lock() {
                    *s = e;
                }
            }
        }
        shared.loading.store(false, Ordering::Release);
    });
}

pub struct SteminizePlayer {
    params: Arc<PlayerParams>,
    shared: Arc<Shared>,
    sample_rate: u32,
    follower: Follower,
}

impl Default for SteminizePlayer {
    fn default() -> Self {
        Self {
            params: Arc::new(PlayerParams::default()),
            shared: Arc::new(Shared::new()),
            sample_rate: 44100,
            follower: Follower::new(44100, 1024),
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
    /// Loads the song the project remembers (or the fallback), if there is one.
    fn start_loading(&self) {
        let saved = self
            .params
            .song_path
            .read()
            .map(|s| s.clone())
            .unwrap_or_default();
        let chosen = if saved.trim().is_empty() {
            fallback_song_path()
        } else {
            Some(PathBuf::from(saved))
        };
        if let Some(path) = chosen {
            spawn_load(&self.shared, path, false);
        }
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
        self.follower = Follower::new(rate, config.max_buffer_size as usize);
        // The song is converted to the DAW's rate when it is loaded, so a change of rate means loading it again.
        self.shared.rate.store(rate, Ordering::Release);
        if rate != self.sample_rate || self.shared.song.load().is_none() {
            self.sample_rate = rate;
            self.start_loading();
        }
        true
    }

    fn editor(&mut self, _async_executor: AsyncExecutor<Self>) -> Option<Box<dyn Editor>> {
        editor::create(
            self.params.clone(),
            self.shared.clone(),
            self.params.editor_state.clone(),
        )
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
        let song = self.shared.song.load();
        let playhead = if transport.playing {
            transport.pos_samples()
        } else {
            None
        };
        let (Some(song), Some(pos)) = (song.as_ref(), playhead) else {
            // Stopped, or no song yet, or the host does not say where it is: silence on every output.
            self.follower.stop();
            self.shared.mode.store(MODE_IDLE, Ordering::Relaxed);
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
        // On the DAW's beats when it says its tempo and position in beats, otherwise on its clock at the song's own speed.
        let beats = transport.pos_beats();
        let mut followed = false;
        let (speed, target) = match (transport.tempo, beats) {
            (Some(tempo), Some(beats))
                if self.params.follow_tempo.value() && song.bpm > 0.0 && tempo > 0.0 =>
            {
                let speed = tempo / song.bpm;
                followed = true;
                (
                    speed,
                    beats * 60.0 / song.bpm * self.sample_rate as f64
                        - song.lead_in as f64
                        - offset as f64 * speed,
                )
            }
            _ => (1.0, (pos - song.lead_in as i64 - offset) as f64),
        };

        let main = buffer.as_slice();
        let (ml, mr) = main.split_at_mut(1);
        // A fixed-size list, so nothing is allocated in the audio callback.
        let mut stem_bufs: ArrayVec<(&mut [f32], &mut [f32]), MAX_STEMS> = ArrayVec::new();
        for out in aux.outputs.iter_mut().take(MAX_STEMS) {
            let ch = out.as_slice();
            let (a, b) = ch.split_at_mut(1);
            stem_bufs.push((&mut *a[0], &mut *b[0]));
        }
        let pitch = self.params.pitch.value() as f64;
        let neutral = (speed - 1.0).abs() < 1e-5 && pitch.abs() < 1e-6;
        let mode = match (neutral, followed) {
            (false, _) => MODE_STRETCH,
            (true, true) => MODE_STRAIGHT,
            (true, false) => MODE_OWN_SPEED,
        };
        self.shared.mode.store(mode, Ordering::Relaxed);
        self.shared.speed.store(speed.to_bits(), Ordering::Relaxed);
        self.shared
            .host_tempo
            .store(transport.tempo.unwrap_or(0.0).to_bits(), Ordering::Relaxed);
        self.follower.render(
            song,
            &settings,
            master,
            Block {
                target,
                speed,
                pitch,
                frames,
            },
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
