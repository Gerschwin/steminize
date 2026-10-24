//! The small description file Steminize's "Send to DAW" writes beside a song's stems (`steminize-song.json`), which the plugin reads to
//! know what to play and where. Times are in seconds on the DAW's timeline; `file` is relative to the folder the description is in.
//! Reading is forgiving: a missing field takes a sensible default, so older or newer descriptions still load.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StemEntry {
    pub name: String,
    pub file: String,
    pub colour: String,
    pub gain: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Default for StemEntry {
    fn default() -> Self {
        Self {
            name: String::new(),
            file: String::new(),
            colour: "#a78bfa".into(),
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MarkerEntry {
    pub name: String,
    pub time_sec: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub title: String,
    pub sample_rate: u32,
    pub bpm: f64,
    pub per_bar: u32,
    /// How many seconds into the DAW's timeline the stems start (a silent lead-in so the song's first bar sits on a bar line).
    pub lead_in_sec: f64,
    pub stems: Vec<StemEntry>,
    pub markers: Vec<MarkerEntry>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            format: 1,
            title: String::new(),
            sample_rate: 44100,
            bpm: 0.0,
            per_bar: 4,
            lead_in_sec: 0.0,
            stems: Vec::new(),
            markers: Vec::new(),
        }
    }
}

pub const MANIFEST_NAME: &str = "steminize-song.json";

impl Manifest {
    pub fn parse(text: &str) -> Result<Manifest, String> {
        let m: Manifest = serde_json::from_str(text)
            .map_err(|e| format!("couldn't read {MANIFEST_NAME}: {e}"))?;
        if m.stems.is_empty() {
            return Err(format!("{MANIFEST_NAME} lists no stems"));
        }
        Ok(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_full_description() {
        let m = Manifest::parse(
            r##"{"format":1,"title":"Song","sampleRate":44100,"bpm":120.1,"perBar":3,"leadInSec":1.198,
            "stems":[{"name":"Bass","file":"a/Bass.wav","colour":"#fff","gain":0.8,"pan":-0.5,"mute":true,"solo":false}],
            "markers":[{"name":"Verse","timeSec":3.2}]}"##,
        )
        .unwrap();
        assert_eq!(m.title, "Song");
        assert_eq!(m.per_bar, 3);
        assert!((m.lead_in_sec - 1.198).abs() < 1e-9);
        assert_eq!(m.stems[0].file, "a/Bass.wav");
        assert!(m.stems[0].mute);
        assert_eq!(m.markers[0].name, "Verse");
    }

    #[test]
    fn missing_fields_take_defaults_and_unknown_ones_are_ignored() {
        let m = Manifest::parse(r#"{"stems":[{"file":"x.wav"}],"somethingNew":{"a":1}}"#).unwrap();
        assert_eq!(m.sample_rate, 44100);
        assert_eq!(m.per_bar, 4);
        assert_eq!(m.lead_in_sec, 0.0);
        assert_eq!(m.stems[0].gain, 1.0);
        assert!(!m.stems[0].mute);
    }

    #[test]
    fn nothing_to_play_or_not_json_is_an_error() {
        assert!(Manifest::parse("{}").is_err());
        assert!(Manifest::parse(r#"{"stems":[]}"#).is_err());
        assert!(Manifest::parse("not json").is_err());
    }
}
