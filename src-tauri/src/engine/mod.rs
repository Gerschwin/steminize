//! The native playback engine: a Rust port of the web player's mixing, EQ, time-stretch and practice
//! sequencing (`src/player/`), so playback can run in the audio driver's own callback instead of the webview's.
//! The TypeScript versions stay the reference and the web fallback.

pub mod eq;
pub mod flac;
pub mod mix;
pub mod renderer;
pub mod resample;
pub mod transport;
