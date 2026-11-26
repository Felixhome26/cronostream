//! Video thumbnails through the operating system's own decoders — Media
//! Foundation on Windows, AVFoundation on macOS.
//!
//! The reason is licensing, not speed: decoding H.264/HEVC needs a patent
//! license, and Microsoft and Apple hold one for the decoders they ship.
//! CronoStream's bundled ffmpeg (tools/ffmpeg-build/) therefore contains no
//! decoders for patent-pool formats at all; `video_preview` asks the
//! system first and only falls back to ffmpeg for formats it can decode
//! with what is left (MJPEG, VP8/VP9, MPEG-1/2, …). Windows' Media
//! Foundation also covers the old AVI/WMV files that are common in family
//! archives. On Linux this module isn't compiled — the distribution's
//! ffmpeg does the work there.

use std::path::Path;

/// Writes the frame at `frame_percent` (0–100) of the video's duration as a
/// JPEG to `dest`, at most 640 px wide — the same rendition the ffmpeg path
/// produces.
pub fn extract_frame(source: &Path, frame_percent: f64, dest: &Path) -> Result<(), String> {
    let frame = platform::grab_frame(source, frame_percent.clamp(0.0, 100.0))?;
    let frame = if frame.width() > 640 {
        let height = ((frame.height() as f64) * 640.0 / frame.width() as f64).round().max(1.0) as u32;
        image::imageops::resize(&frame, 640, height, image::imageops::FilterType::Triangle)
    } else {
        frame
    };
    let file = std::fs::File::create(dest).map_err(|e| crate::trf!("Konnte Vorschaubild nicht schreiben: {e}", e = e))?;
    image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 88)
        .encode_image(&frame)
        .map_err(|e| crate::trf!("Konnte Vorschaubild nicht speichern: {e}", e = e))
}

#[cfg(windows)]
mod platform {
    use std::path::Path;

    use image::{Rgb, RgbImage};
    use windows::core::{GUID, HSTRING};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VT_I8;

    const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

    fn mf_error(error: windows::core::Error) -> String {
        format!("Media Foundation: {error}")
    }

    pub fn grab_frame(source: &Path, percent: f64) -> Result<RgbImage, String> {
        unsafe {
            // Thumbnails run on worker threads; each one sets COM and Media
            // Foundation up for itself and tears it down again.
            let com = CoInitializeEx(None, COINIT_MULTITHREADED);
            let started = MFStartup(MF_VERSION, MFSTARTUP_LITE);
            let result = match &started {
                Ok(()) => read_frame(source, percent),
                Err(error) => Err(mf_error(error.clone())),
            };
            if started.is_ok() {
                let _ = MFShutdown();
            }
            if com.is_ok() {
                CoUninitialize();
            }
            result
        }
    }

    unsafe fn read_frame(source: &Path, percent: f64) -> Result<RgbImage, String> {
        let mut attributes: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attributes, 1).map_err(mf_error)?;
        let attributes = attributes.ok_or(crate::i18n::tr("Media Foundation: keine Attribute"))?;
        // Lets the reader convert whatever the decoder outputs to RGB32.
        attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1).map_err(mf_error)?;

        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(source.as_os_str()), &attributes).map_err(mf_error)?;
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).map_err(mf_error)?;
        reader.SetStreamSelection(VIDEO, true).map_err(mf_error)?;

        let wanted = MFCreateMediaType().map_err(mf_error)?;
        wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(mf_error)?;
        wanted.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(mf_error)?;
        reader.SetCurrentMediaType(VIDEO, None, &wanted).map_err(mf_error)?;

        let current = reader.GetCurrentMediaType(VIDEO).map_err(mf_error)?;
        let size = current.GetUINT64(&MF_MT_FRAME_SIZE).map_err(mf_error)?;
        let (width, height) = ((size >> 32) as u32, (size & 0xFFFF_FFFF) as u32);
        if width == 0 || height == 0 {
            return Err(crate::i18n::tr("Media Foundation: Video hat keine Bildgröße.").to_string());
        }
        // Negative = bottom-up rows. Absent means tightly packed, top-down.
        let stride = current.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32).unwrap_or(width as i32 * 4);

        // Duration in 100 ns units, then seek there (GUID_NULL = 100 ns).
        let mut duration = reader
            .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
            .map_err(mf_error)?;
        let total = duration.Anonymous.Anonymous.Anonymous.uhVal;
        let _ = PropVariantClear(&mut duration);
        let position = (total as f64 * percent / 100.0) as i64;
        if position > 0 {
            let mut target = PROPVARIANT::default();
            (*target.Anonymous.Anonymous).vt = VT_I8;
            (*target.Anonymous.Anonymous).Anonymous.hVal = position;
            // Best effort: if seeking fails, the first frame is still a
            // usable thumbnail.
            let _ = reader.SetCurrentPosition(&GUID::zeroed(), &target);
        }

        // A read can come back without a sample (stream gaps, format
        // changes); keep reading until there is one or the stream ends.
        for _ in 0..300 {
            let mut flags = 0u32;
            let mut sample: Option<IMFSample> = None;
            reader
                .ReadSample(VIDEO, 0, None, Some(&mut flags as *mut u32), None, Some(&mut sample as *mut Option<IMFSample>))
                .map_err(mf_error)?;
            if let Some(sample) = sample {
                return to_image(&sample, width, height, stride);
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
        Err(crate::i18n::tr("Media Foundation: kein Videobild gefunden.").to_string())
    }

    /// RGB32 is BGRX in memory.
    unsafe fn to_image(sample: &IMFSample, width: u32, height: u32, stride: i32) -> Result<RgbImage, String> {
        let buffer = sample.ConvertToContiguousBuffer().map_err(mf_error)?;
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut length = 0u32;
        buffer.Lock(&mut data, None, Some(&mut length as *mut u32)).map_err(mf_error)?;

        let row_bytes = stride.unsigned_abs() as usize;
        let (w, h) = (width as usize, height as usize);
        let result = if data.is_null() || row_bytes < w * 4 || (length as usize) < row_bytes * h {
            Err("Media Foundation: unerwartetes Bildformat.".to_string())
        } else {
            let bytes = std::slice::from_raw_parts(data, length as usize);
            Ok(RgbImage::from_fn(width, height, |x, y| {
                let row = if stride < 0 { h - 1 - y as usize } else { y as usize };
                let px = &bytes[row * row_bytes + x as usize * 4..][..3];
                Rgb([px[2], px[1], px[0]])
            }))
        };
        let _ = buffer.Unlock();
        result
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::Path;

    use image::{Rgb, RgbImage};
    use objc2_av_foundation::{AVAssetImageGenerator, AVURLAsset};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo};
    use objc2_core_media::CMTime;
    use objc2_foundation::{NSString, NSURL};

    pub fn grab_frame(source: &Path, percent: f64) -> Result<RgbImage, String> {
        let image = unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(&source.to_string_lossy()));
            let asset = AVURLAsset::URLAssetWithURL_options(&url, None);
            #[allow(deprecated)]
            let duration = asset.duration().seconds();
            let seconds = if duration.is_finite() && duration > 0.0 { duration * percent / 100.0 } else { 0.0 };

            let generator = AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset);
            // Portrait phone videos are stored rotated; apply the rotation.
            generator.setAppliesPreferredTrackTransform(true);
            // 640 px wide like the ffmpeg path; the height is left free.
            generator.setMaximumSize(CGSize { width: 640.0, height: 4096.0 });
            // The synchronous call is deprecated in favour of a callback
            // API, but this runs on a worker thread anyway.
            #[allow(deprecated)]
            generator
                .copyCGImageAtTime_actualTime_error(CMTime::with_seconds(seconds, 600), std::ptr::null_mut())
                .map_err(|error| format!("AVFoundation: {}", error.localizedDescription()))?
        };
        to_rgb(&image)
    }

    /// Draws the image into an RGBX buffer we own and copies it out.
    fn to_rgb(image: &CGImage) -> Result<RgbImage, String> {
        let (width, height) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
        if width == 0 || height == 0 {
            return Err("AVFoundation: leeres Bild.".to_string());
        }
        let mut pixels = vec![0u8; width * height * 4];
        let space = CGColorSpace::new_device_rgb().ok_or(crate::i18n::tr("AVFoundation: kein Farbraum"))?;
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr().cast(),
                width,
                height,
                8,
                width * 4,
                Some(&space),
                CGImageAlphaInfo::NoneSkipLast.0,
            )
        }
        .ok_or(crate::i18n::tr("AVFoundation: Bildpuffer konnte nicht angelegt werden"))?;
        let rect = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: width as f64, height: height as f64 } };
        CGContext::draw_image(Some(&context), rect, Some(image));
        drop(context);

        Ok(RgbImage::from_fn(width as u32, height as u32, |x, y| {
            let px = &pixels[(y as usize * width + x as usize) * 4..][..3];
            Rgb([px[0], px[1], px[2]])
        }))
    }
}
