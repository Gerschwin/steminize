//! Reads the library's FLAC stem files back into stereo floats, undoing the scale they were stored with
//! (see `loadStems` in `src/library.ts`, which this mirrors).

use super::mix::Stereo;

/// Decodes a FLAC file; mono is copied to both channels, extra channels are ignored. `scale` is the factor the
/// stem was multiplied by before it was stored (so it is divided out here).
pub fn decode_flac(bytes: &[u8], scale: f32) -> Result<Stereo, String> {
    let mut reader = claxon::FlacReader::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let info = reader.streaminfo();
    let channels = info.channels as usize;
    if channels == 0 {
        return Err("FLAC has no channels".into());
    }
    let full_scale = (1u64 << (info.bits_per_sample - 1)) as f32;
    let k = if scale != 0.0 { 1.0 / (scale * full_scale) } else { 1.0 / full_scale };
    let frames = info.samples.unwrap_or(0) as usize;
    let (mut l, mut r) = (Vec::with_capacity(frames), Vec::with_capacity(frames));
    let mut i = 0usize;
    for s in reader.samples() {
        let v = s.map_err(|e| e.to_string())? as f32 * k;
        match i % channels {
            0 => l.push(v),
            1 => r.push(v),
            _ => {}
        }
        i += 1;
    }
    if channels == 1 {
        r = l.clone();
    }
    Ok((l, r))
}
