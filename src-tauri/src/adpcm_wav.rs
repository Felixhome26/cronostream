//! IMA-ADPCM WAV files (old dictation recorders, Windows Sound Recorder)
//! turned into plain 16-bit PCM WAV.
//!
//! WebKitGTK plays audio through GStreamer, whose WAV demuxer in the webview
//! environment doesn't decode WAV format tag 0x11, so such a file shows
//! "format not supported". The media server hands the player the converted
//! bytes instead; the file on disk is never touched.

const INDEX_TABLE: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

const STEP_TABLE: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];

struct Channel {
    predictor: i32,
    index: i32,
}

impl Channel {
    fn decode(&mut self, nibble: u8) -> i16 {
        let step = STEP_TABLE[self.index as usize];
        let mut diff = step >> 3;
        if nibble & 1 != 0 {
            diff += step >> 2;
        }
        if nibble & 2 != 0 {
            diff += step >> 1;
        }
        if nibble & 4 != 0 {
            diff += step;
        }
        if nibble & 8 != 0 {
            diff = -diff;
        }
        self.predictor = (self.predictor + diff).clamp(-32768, 32767);
        self.index = (self.index + INDEX_TABLE[(nibble & 7) as usize]).clamp(0, 88);
        self.predictor as i16
    }
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Looks at the start of a WAV only: `Some(true)` when its `fmt ` chunk
/// says IMA-ADPCM, `Some(false)` when it says anything else or the file is
/// no WAV at all, `None` when `head` ends before the `fmt ` chunk (an
/// unusually long chunk in front of it) — then only the whole file can tell.
pub fn is_ima_adpcm(head: &[u8]) -> Option<bool> {
    if head.len() < 12 {
        return None;
    }
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return Some(false);
    }
    let mut pos = 12;
    while pos + 8 <= head.len() {
        let size = u32_at(head, pos + 4)? as usize;
        if &head[pos..pos + 4] == b"fmt " {
            return u16_at(head, pos + 8).map(|tag| tag == 0x11);
        }
        pos = (pos + 8).saturating_add(size).saturating_add(size & 1);
    }
    None
}

/// `Some(pcm_wav)` when `bytes` is an IMA-ADPCM WAV, `None` for anything else
/// (including malformed files, which are then served as they are).
pub fn to_pcm_wav(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.get(0..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut fmt: Option<(usize, usize, u32)> = None; // channels, block_align, rate
    let mut data: Option<&[u8]> = None;
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32_at(bytes, pos + 4)? as usize;
        let body_start = pos + 8;
        let body_end = body_start.saturating_add(size).min(bytes.len());
        let body = &bytes[body_start..body_end];
        if id == b"fmt " {
            if u16_at(body, 0)? != 0x11 || u16_at(body, 14)? != 4 {
                return None;
            }
            fmt = Some((u16_at(body, 2)? as usize, u16_at(body, 12)? as usize, u32_at(body, 4)?));
        } else if id == b"data" {
            data = Some(body);
        }
        pos = body_start.saturating_add(size).saturating_add(size & 1);
    }
    let (channels, block_align, rate) = fmt?;
    let data = data?;
    if channels == 0 || channels > 2 || block_align < 4 * channels {
        return None;
    }

    let mut pcm: Vec<i16> = Vec::with_capacity(data.len() * 2);
    for block in data.chunks(block_align) {
        let header = 4 * channels;
        if block.len() < header {
            break;
        }
        let mut state: Vec<Channel> = (0..channels)
            .map(|c| Channel {
                predictor: i16::from_le_bytes([block[4 * c], block[4 * c + 1]]) as i32,
                index: (block[4 * c + 2] as i32).min(88),
            })
            .collect();
        let frames_start = pcm.len();
        // Header sample of every channel, interleaved.
        for c in &state {
            pcm.push(c.predictor as i16);
        }
        // Then groups of 4 bytes (8 samples) per channel, channel after channel.
        for group in block[header..].chunks(4 * channels) {
            let samples_per_channel = group.len() / channels * 2;
            let base = pcm.len();
            pcm.resize(base + samples_per_channel * channels, 0);
            for (c, ch) in state.iter_mut().enumerate() {
                for (i, byte) in group[c * (group.len() / channels)..(c + 1) * (group.len() / channels)]
                    .iter()
                    .enumerate()
                {
                    pcm[base + (i * 2) * channels + c] = ch.decode(byte & 0x0F);
                    pcm[base + (i * 2 + 1) * channels + c] = ch.decode(byte >> 4);
                }
            }
        }
        debug_assert!(pcm.len() > frames_start);
    }

    let data_len = (pcm.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + pcm.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(channels as u16).to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    out.extend_from_slice(&(channels as u16 * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_dictation_sample_decodes_to_pcm_of_the_right_length() {
        // Header only: mono, 8 kHz, block 512 bytes -> 1017 samples per block.
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        wav.extend_from_slice(&20u32.to_le_bytes());
        wav.extend_from_slice(&0x11u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&4000u32.to_le_bytes());
        wav.extend_from_slice(&512u16.to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&1017u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&512u32.to_le_bytes());
        wav.extend_from_slice(&[0u8; 512]);
        let out = to_pcm_wav(&wav).expect("ADPCM erkannt");
        assert_eq!(&out[20..22], &1u16.to_le_bytes());
        assert_eq!((out.len() - 44) / 2, 1017);
    }

    #[test]
    fn the_format_tag_is_read_from_the_start_alone() {
        let header = |tag: u16| {
            let mut wav = Vec::new();
            wav.extend_from_slice(b"RIFF\0\0\0\0WAVE");
            wav.extend_from_slice(b"LIST");
            wav.extend_from_slice(&3u32.to_le_bytes());
            wav.extend_from_slice(b"abc\0"); // odd size, padded
            wav.extend_from_slice(b"fmt ");
            wav.extend_from_slice(&16u32.to_le_bytes());
            wav.extend_from_slice(&tag.to_le_bytes());
            wav
        };
        assert_eq!(is_ima_adpcm(&header(0x11)), Some(true));
        assert_eq!(is_ima_adpcm(&header(1)), Some(false));
        assert_eq!(is_ima_adpcm(b"ID3 not a wave file"), Some(false));
        assert_eq!(is_ima_adpcm(&header(0x11)[..20]), None, "fmt chunk not reached yet");
    }

    #[test]
    fn plain_pcm_is_left_alone() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&[0u8; 14]);
        assert!(to_pcm_wav(&wav).is_none());
    }
}
