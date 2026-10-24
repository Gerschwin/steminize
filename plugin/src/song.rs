//! Loading a song: read the description, read each stem's WAV, and convert it to the rate the DAW is running at. All of this happens on a
//! background thread, never in the audio callback.

use crate::manifest::{Manifest, MANIFEST_NAME};
use crate::mix::{Song, Stem, MAX_STEMS};
use std::path::{Path, PathBuf};

/// Where the description is, given what the user pointed at: the folder it is in, or the file itself.
pub fn manifest_path(chosen: &Path) -> PathBuf {
    if chosen.is_dir() {
        chosen.join(MANIFEST_NAME)
    } else {
        chosen.to_path_buf()
    }
}

/// Reads a WAV file (16, 24 or 32-bit integer, or 32-bit float; any channel count) as two channels of f32 and its sample rate.
pub fn read_wav(path: &Path) -> Result<(Vec<f32>, Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("couldn't open {}: {e}", path.display()))?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?
        }
    };
    let frames = samples.len() / ch;
    let mut l = Vec::with_capacity(frames);
    let mut r = Vec::with_capacity(frames);
    for f in 0..frames {
        let a = samples[f * ch];
        l.push(a);
        r.push(if ch > 1 { samples[f * ch + 1] } else { a });
    }
    Ok((l, r, spec.sample_rate))
}

/// Resamples one channel from `from` to `to` Hz with cubic (Catmull-Rom) interpolation. Done once, when a song is loaded.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let at = |i: isize| -> f32 { input[i.clamp(0, input.len() as isize - 1) as usize] };
    (0..out_len)
        .map(|n| {
            let pos = n as f64 * ratio;
            let i = pos.floor() as isize;
            let t = (pos - i as f64) as f32;
            let (p0, p1, p2, p3) = (at(i - 1), at(i), at(i + 1), at(i + 2));
            0.5 * ((2.0 * p1)
                + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t)
        })
        .collect()
}

/// Loads the song at `chosen` (a folder holding `steminize-song.json`, or that file) for a DAW running at `host_rate`.
pub fn load(chosen: &Path, host_rate: u32) -> Result<Song, String> {
    let manifest_file = manifest_path(chosen);
    let text = std::fs::read_to_string(&manifest_file)
        .map_err(|e| format!("couldn't read {}: {e}", manifest_file.display()))?;
    let manifest = Manifest::parse(&text)?;
    let base = manifest_file.parent().unwrap_or(Path::new("."));
    let mut stems = Vec::new();
    for entry in manifest.stems.iter().take(MAX_STEMS) {
        let (l, r, rate) = read_wav(&base.join(&entry.file))?;
        let (l, r) = if rate == host_rate {
            (l, r)
        } else {
            (resample(&l, rate, host_rate), resample(&r, rate, host_rate))
        };
        let name = if entry.name.is_empty() {
            format!("Stem {}", stems.len() + 1)
        } else {
            entry.name.clone()
        };
        stems.push(Stem {
            name,
            left: l,
            right: r,
            base_gain: entry.gain.max(0.0),
            pan: entry.pan.clamp(-1.0, 1.0),
        });
    }
    let len = stems.iter().map(|s| s.left.len()).max().unwrap_or(0);
    let to_frames = |sec: f64| (sec.max(0.0) * host_rate as f64).round() as usize;
    Ok(Song {
        title: manifest.title,
        bpm: manifest.bpm,
        per_bar: manifest.per_bar.max(1),
        lead_in: to_frames(manifest.lead_in_sec),
        stems,
        markers: manifest
            .markers
            .iter()
            .map(|m| (m.name.clone(), to_frames(m.time_sec)))
            .collect(),
        len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("steminize-plugin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_wav(path: &Path, rate: u32, bits: u16, frames: &[(f32, f32)]) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: rate,
            bits_per_sample: bits,
            sample_format: if bits == 32 {
                hound::SampleFormat::Float
            } else {
                hound::SampleFormat::Int
            },
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for (l, r) in frames {
            if bits == 32 {
                w.write_sample(*l).unwrap();
                w.write_sample(*r).unwrap();
            } else {
                let max = (1i64 << (bits - 1)) as f32;
                w.write_sample((l * (max - 1.0)) as i32).unwrap();
                w.write_sample((r * (max - 1.0)) as i32).unwrap();
            }
        }
        w.finalize().unwrap();
    }

    #[test]
    fn reads_16_24_and_32_bit_wavs_as_the_same_audio() {
        let dir = temp("bits");
        let frames: Vec<(f32, f32)> = (0..100)
            .map(|i| (((i as f32) / 100.0) - 0.5, 0.25))
            .collect();
        for bits in [16u16, 24, 32] {
            let p = dir.join(format!("a{bits}.wav"));
            write_wav(&p, 44100, bits, &frames);
            let (l, r, rate) = read_wav(&p).unwrap();
            assert_eq!(rate, 44100);
            assert_eq!(l.len(), 100);
            assert!((l[10] - frames[10].0).abs() < 0.001, "{bits}-bit left");
            assert!((r[10] - 0.25).abs() < 0.001, "{bits}-bit right");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resampling_keeps_a_sine_a_sine_and_changes_the_length() {
        let from = 44100u32;
        let to = 48000u32;
        let sine: Vec<f32> = (0..44100)
            .map(|n| (2.0 * std::f32::consts::PI * 440.0 * n as f32 / from as f32).sin())
            .collect();
        let out = resample(&sine, from, to);
        assert!((out.len() as i64 - 48000).abs() <= 1);
        let worst = out
            .iter()
            .enumerate()
            .skip(10)
            .take(40000)
            .map(|(n, v)| {
                (v - (2.0 * std::f32::consts::PI * 440.0 * n as f32 / to as f32).sin()).abs()
            })
            .fold(0.0f32, f32::max);
        assert!(worst < 0.01, "the resampled sine strays by {worst}");
        assert_eq!(resample(&sine, from, from).len(), sine.len());
    }

    #[test]
    fn loads_a_song_from_a_folder_and_converts_its_rate_and_lead_in() {
        let dir = temp("song");
        write_wav(&dir.join("Bass.wav"), 44100, 16, &vec![(0.5, 0.5); 44100]);
        write_wav(
            &dir.join("Drums.wav"),
            44100,
            24,
            &vec![(0.25, -0.25); 22050],
        );
        std::fs::write(
            dir.join(MANIFEST_NAME),
            r#"{"title":"Song","bpm":120,"perBar":4,"leadInSec":1.0,"stems":[{"name":"Bass","file":"Bass.wav","gain":0.8},{"name":"Drums","file":"Drums.wav","pan":-1}],"markers":[{"name":"Verse","timeSec":2}]}"#,
        )
        .unwrap();
        let song = load(&dir, 48000).unwrap();
        assert_eq!(song.title, "Song");
        assert_eq!(song.stems.len(), 2);
        assert!(
            (song.stems[0].left.len() as i64 - 48000).abs() <= 1,
            "one second at 48 kHz"
        );
        assert_eq!(song.lead_in, 48000);
        assert_eq!(song.markers[0], ("Verse".to_string(), 96000));
        assert_eq!(song.stems[0].base_gain, 0.8);
        assert_eq!(song.stems[1].pan, -1.0);
        assert_eq!(song.len, song.stems[0].left.len());
        // The file itself can be given instead of its folder.
        assert_eq!(
            load(&dir.join(MANIFEST_NAME), 44100).unwrap().stems.len(),
            2
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_stem_file_or_description_is_a_clear_error() {
        let dir = temp("missing");
        assert!(load(&dir, 44100)
            .unwrap_err()
            .contains("steminize-song.json"));
        std::fs::write(
            dir.join(MANIFEST_NAME),
            r#"{"stems":[{"file":"nope.wav"}]}"#,
        )
        .unwrap();
        assert!(load(&dir, 44100).unwrap_err().contains("nope.wav"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mono_file_plays_on_both_sides() {
        let dir = temp("mono");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 44100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(dir.join("m.wav"), spec).unwrap();
        for _ in 0..10 {
            w.write_sample(16000i16).unwrap();
        }
        w.finalize().unwrap();
        let (l, r, _) = read_wav(&dir.join("m.wav")).unwrap();
        assert_eq!(l, r);
        assert_eq!(l.len(), 10);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
