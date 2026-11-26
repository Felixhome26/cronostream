# CronoStream ffmpeg (LGPL)

The ffmpeg that ships inside CronoStream's Windows and macOS installers
(recording, video thumbnails). Built here, from exact upstream
sources, so it is known what is in it and under which license.

The build runs in this repository's GitHub Actions
(`.github/workflows/ffmpeg-build.yml`); `scripts/fetch-ffmpeg.mjs` puts the
result into the Windows and macOS installers (Tauri `externalBin`). Each
release also carries `ffmpeg-sources.zip`, the complete corresponding
source for the LGPL.

## What is in it

| | License |
|---|---|
| ffmpeg (`versions.env`), built **without** `--enable-gpl`/`--enable-nonfree` | LGPL 2.1+ |
| libvpx — VP8/VP9 encoder | BSD-3-Clause (+ Google patent grant) |
| libopus — Opus encoder | BSD-3-Clause |
| zlib — for the PNG/TIFF decoders (Windows only; macOS uses the system's) | zlib license |

H.264 and AAC are encoded only through the operating system's own,
vendor-licensed encoders (Media Foundation on Windows, VideoToolbox /
AudioToolbox on macOS). ffmpeg's built-in AAC encoder and other encoders
for patent-pool formats are left out of the build (`DISABLED_ENCODERS` in
`common.sh`), and decoders are an allowlist (`ENABLED_DECODERS`): free
formats plus the old ones CronoStream converts when the webview can't play
them (WMA/WMV, MPEG-4 Part 2/DivX, ADPCM/GSM, Cinepak/Indeo, AMR …) — no
H.264, HEVC, AAC or AC-3, which the webviews play themselves. Video
thumbnails come from the operating system's decoders. The build fails if
the result isn't LGPL or contains any of the excluded encoders/decoders.

Every zip contains `ffmpeg`, `ffprobe`, `licenses/` and `SOURCES.txt`
(exact source versions, configure line, link to this recipe).

## Releasing

1. Adjust `versions.env` if needed.
2. Push a tag `ffmpeg-<ffmpeg version>-<build number>`, e.g. `ffmpeg-n8.1.3-1`.
3. The workflow builds Windows x86_64, macOS arm64 and macOS x86_64 plus the
   source archive and publishes them as a release of this repository.
4. Set the same tag as `FFMPEG_RELEASE` in `scripts/fetch-ffmpeg.mjs`.

## Linux

`build-linux.sh` is not part of the workflow: `scripts/build-appimage.mjs`
runs it on the machine that builds the AppImage, and the result stays in
`~/.cache/cronostream-ffmpeg/`. It differs from the builds above on purpose:

- It has **every decoder**, H.264, HEVC, AAC and WMV included. Linux has no
  system decoders to rely on, and without them the AppImage couldn't play
  what phones record.
- It builds **shared libraries**, which replace Ubuntu's libav* under
  GStreamer's libav plugin. `FFMPEG_LINUX_VERSION` must therefore have the
  same major version as the build machine's `libavcodec`.
- Encoders are an allowlist (MJPEG, PCM, VP8/VP9, Opus): what thumbnails and
  recording ask for. There's no H.264 or AAC encoder, and the build fails if
  the result isn't LGPL.
