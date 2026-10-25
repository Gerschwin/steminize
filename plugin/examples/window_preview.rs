//! Opens the plugin's window without a DAW, as a child of the X11 root window, so it can be looked at (and screenshotted under Xvfb).
//! Usage: window_preview <root window id> <song folder>   (the root id comes from `xwininfo -root`)

use nih_plug::prelude::*;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use steminize_player::{editor, spawn_load, PlayerParams, Shared, MODE_STRETCH};

struct Dummy;

impl GuiContext for Dummy {
    fn plugin_api(&self) -> PluginApi {
        PluginApi::Vst3
    }
    fn request_resize(&self) -> bool {
        false
    }
    unsafe fn raw_begin_set_parameter(&self, _param: ParamPtr) {}
    // Parameters cannot be set from outside the framework, so in this preview the controls are for looking at only.
    unsafe fn raw_set_parameter_normalized(&self, _param: ParamPtr, _normalized: f32) {}
    unsafe fn raw_end_set_parameter(&self, _param: ParamPtr) {}
    fn get_state(&self) -> PluginState {
        unimplemented!()
    }
    fn set_state(&self, _state: PluginState) {}
}

fn main() {
    let mut args = std::env::args().skip(1);
    let root: u32 = args
        .next()
        .and_then(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .expect("root window id (hex)");
    let song = args.next().map(PathBuf::from);
    let params = Arc::new(PlayerParams::default());
    let shared = Arc::new(Shared::new());
    if let Some(song) = song {
        spawn_load(&shared, song, true);
    }
    shared.host_tempo.store(100f64.to_bits(), Ordering::Relaxed);
    shared
        .speed
        .store((100.0f64 / 120.0).to_bits(), Ordering::Relaxed);
    shared.mode.store(MODE_STRETCH, Ordering::Relaxed);
    // Some made-up levels, so the meters have something to show.
    let feeder = shared.clone();
    std::thread::spawn(move || loop {
        for (i, p) in feeder.peaks.iter().enumerate() {
            p.store(
                (0.9f32 / (1.0 + i as f32 * 1.5)).to_bits(),
                Ordering::Relaxed,
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    });
    let editor = editor::create(params.clone(), shared, params.editor_state_arc()).expect("editor");
    let _window = editor.spawn(ParentWindowHandle::X11Window(root), Arc::new(Dummy));
    std::thread::sleep(std::time::Duration::from_secs(60));
}
