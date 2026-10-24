//! The plugin's window: choose a song, see its stems with their levels, mute and solo, and see how the DAW's tempo compares with the song's.

use crate::{PlayerParams, Shared, MODE_IDLE, MODE_STRAIGHT, MODE_STRETCH};
use nih_plug::prelude::*;
use nih_plug_egui::widgets::ParamSlider;
use nih_plug_egui::{create_egui_editor, egui, EguiState};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub const WIDTH: u32 = 600;
pub const HEIGHT: u32 = 520;

struct Ui {
    path: String,
    seeded: bool,
}

fn set_bool(setter: &ParamSetter, p: &BoolParam, v: bool) {
    setter.begin_set_parameter(p);
    setter.set_parameter(p, v);
    setter.end_set_parameter(p);
}

pub fn create(
    params: Arc<PlayerParams>,
    shared: Arc<Shared>,
    state: Arc<EguiState>,
) -> Option<Box<dyn Editor>> {
    create_egui_editor(
        state,
        Ui {
            path: String::new(),
            seeded: false,
        },
        |ctx, _| {
            ctx.set_visuals(egui::Visuals::dark());
        },
        move |ctx, setter, ui_state| {
            if !ui_state.seeded {
                ui_state.seeded = true;
                ui_state.path = params
                    .song_path
                    .read()
                    .map(|s| s.clone())
                    .unwrap_or_default();
            }
            // A song just loaded from this window takes on the mute and solo settings it had in Steminize.
            let song = shared.song.load_full();
            if shared.apply_song_mix.swap(false, Ordering::AcqRel) {
                if let Some(song) = song.as_ref() {
                    for (i, p) in params.stems.iter().enumerate() {
                        let s = song.stems.get(i);
                        set_bool(setter, &p.mute, s.is_some_and(|s| s.mute));
                        set_bool(setter, &p.solo, s.is_some_and(|s| s.solo));
                    }
                }
            }
            egui::CentralPanel::default().show(ctx, |ui| {
                ui.heading("Steminize Player");
                ui.add_space(6.0);

                ui.horizontal(|ui| {
                    ui.label("Song folder");
                    let width = ui.available_width() - 70.0;
                    ui.add(egui::TextEdit::singleline(&mut ui_state.path).desired_width(width).hint_text("the folder Send to DAW wrote"));
                    let busy = shared.loading.load(Ordering::Acquire);
                    if ui.add_enabled(!busy && !ui_state.path.trim().is_empty(), egui::Button::new("Load")).clicked() {
                        let path = ui_state.path.trim().to_string();
                        if let Ok(mut saved) = params.song_path.write() {
                            *saved = path.clone();
                        }
                        crate::spawn_load(&shared, PathBuf::from(path), true);
                    }
                });
                if shared.loading.load(Ordering::Acquire) {
                    ui.label("Loading…");
                }
                let status = shared.status.lock().map(|s| s.clone()).unwrap_or_default();
                if !status.is_empty() {
                    ui.colored_label(egui::Color32::from_rgb(0xff, 0x9a, 0x7a), status);
                }
                ui.add_space(4.0);

                match song.as_ref() {
                    None => {
                        ui.label("No song loaded. In Steminize, open a song, press Send to DAW, then paste the folder it wrote here.");
                    }
                    Some(song) => {
                        ui.strong(&song.title);
                        let host = f64::from_bits(shared.host_tempo.load(Ordering::Relaxed));
                        let speed = f64::from_bits(shared.speed.load(Ordering::Relaxed));
                        let how = match shared.mode.load(Ordering::Relaxed) {
                            MODE_STRAIGHT => "playing at the song's own speed".to_string(),
                            MODE_STRETCH => format!("following the DAW at {:.0}% speed", speed * 100.0),
                            MODE_IDLE => "stopped".to_string(),
                            _ => "at the song's own speed (the DAW gave no tempo, or Follow tempo is off)".to_string(),
                        };
                        let host_text = if host > 0.0 { format!("{host:.1} bpm") } else { "not reported".to_string() };
                        ui.label(format!("Song {:.1} bpm, DAW {host_text}: {how}", song.bpm));
                    }
                }
                ui.separator();

                egui::Grid::new("controls").num_columns(2).spacing([12.0, 6.0]).show(ui, |ui| {
                    ui.label("Master");
                    ui.add(ParamSlider::for_param(&params.master, setter).with_width(260.0));
                    ui.end_row();
                    ui.label("Offset");
                    ui.add(ParamSlider::for_param(&params.offset_ms, setter).with_width(260.0));
                    ui.end_row();
                    ui.label("Key shift");
                    ui.add(ParamSlider::for_param(&params.pitch, setter).with_width(260.0));
                    ui.end_row();
                    ui.label("Follow tempo");
                    let mut follow = params.follow_tempo.value();
                    if ui.checkbox(&mut follow, "Speed up and slow down with the DAW").changed() {
                        set_bool(setter, &params.follow_tempo, follow);
                    }
                    ui.end_row();
                });
                ui.separator();

                if let Some(song) = song.as_ref() {
                    egui::Grid::new("stems").num_columns(5).spacing([10.0, 6.0]).show(ui, |ui| {
                        for (i, stem) in song.stems.iter().enumerate() {
                            let Some(p) = params.stems.get(i) else { break };
                            ui.horizontal(|ui| {
                                ui.set_max_width(120.0);
                                let [r, g, b] = stem.colour;
                                let (rect, _) = ui.allocate_exact_size(egui::vec2(10.0, 18.0), egui::Sense::hover());
                                ui.painter().rect_filled(rect, 2.0, egui::Color32::from_rgb(r, g, b));
                                ui.add(egui::Label::new(&stem.name).truncate());
                            });
                            ui.add(ParamSlider::for_param(&p.gain, setter).with_width(230.0));
                            let mut mute = p.mute.value();
                            if ui.toggle_value(&mut mute, "M").on_hover_text("Mute").changed() {
                                set_bool(setter, &p.mute, mute);
                            }
                            let mut solo = p.solo.value();
                            if ui.toggle_value(&mut solo, "S").on_hover_text("Solo").changed() {
                                set_bool(setter, &p.solo, solo);
                            }
                            ui.label(egui::RichText::new(format!("out {}", i + 1)).weak());
                            ui.end_row();
                        }
                    });
                    ui.add_space(4.0);
                    if ui.button("Use the mute and solo from Steminize").clicked() {
                        shared.apply_song_mix.store(true, Ordering::Release);
                    }
                }
            });
        },
    )
}
