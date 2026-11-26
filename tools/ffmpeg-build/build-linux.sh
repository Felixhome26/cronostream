#!/usr/bin/env bash
# Linux x86_64 build for the AppImage, made on the machine that builds the
# AppImage (scripts/build-appimage.mjs runs this when the result is missing).
#   sudo apt-get install nasm libopus-dev libvpx-dev libaom-dev libpulse-dev
#
# Unlike the Windows/macOS builds this one has every decoder: Linux has no
# system decoders to fall back on, and playing what phones record is the
# point of the app. Encoders stay an allowlist of what `capture.rs` and
# `video_preview.rs` ask for.
#
# Shared libraries, because GStreamer's libav plugin links them: they replace
# Ubuntu's libav*, whose --enable-gpl build drags in x264, x265 and some
# hundred further libraries. That only works with the same major version as
# the distribution's, so FFMPEG_LINUX_VERSION follows the build machine's
# (`ffmpeg -version`), not FFMPEG_VERSION.
#
# Opus, VPx, AOM and PulseAudio are the distribution's shared libraries, which
# the AppImage carries anyway; `collect-appimage-licenses.mjs` lists them.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/versions.env"

CACHE="$HOME/.cache/cronostream-ffmpeg"
export OUT="${OUT:-$CACHE/$FFMPEG_LINUX_VERSION}"
export WORK="$CACHE/work"
[ -f "$OUT/.complete" ] && { echo "Already built: $OUT"; exit 0; }
rm -rf "$OUT" "$WORK"
source "$HERE/common.sh"

git clone --depth 1 --branch "$FFMPEG_LINUX_VERSION" https://github.com/FFmpeg/FFmpeg.git "$SRC/ffmpeg"

# common.sh hides every library from configure; these are the allowed ones.
mkdir -p "$PREFIX/lib/pkgconfig"
for pc in opus vpx aom libpulse; do
  ln -s "/usr/lib/x86_64-linux-gnu/pkgconfig/$pc.pc" "$PREFIX/lib/pkgconfig/$pc.pc"
done

ENCODERS="mjpeg,pcm_s16le,libvpx_vp8,libvpx_vp9,libopus"

(cd "$SRC/ffmpeg" && ./configure --prefix="$OUT" \
  --arch=x86_64 --toolchain=hardened \
  --enable-shared --disable-static \
  --disable-autodetect --disable-debug --disable-doc --disable-ffplay --disable-network \
  --enable-zlib --enable-bzlib --enable-libpulse --enable-libvpx --enable-libopus --enable-libaom \
  --disable-encoders --enable-encoder="$ENCODERS")

config="$SRC/ffmpeg/config.h"
components="$SRC/ffmpeg/config_components.h"
grep -q '#define FFMPEG_LICENSE "LGPL version 2.1 or later"' "$config" || {
  echo "ERROR: build is not LGPL 2.1+"; grep FFMPEG_LICENSE "$config"; exit 1; }
for wanted in CONFIG_H264_DECODER CONFIG_HEVC_DECODER CONFIG_AAC_DECODER CONFIG_MPEG4_DECODER \
    CONFIG_VC1_DECODER CONFIG_WMV3_DECODER CONFIG_AC3_DECODER CONFIG_VP9_DECODER CONFIG_LIBAOM_AV1_DECODER \
    CONFIG_PULSE_INDEV CONFIG_V4L2_INDEV CONFIG_LIBVPX_VP9_ENCODER CONFIG_LIBOPUS_ENCODER CONFIG_MJPEG_ENCODER; do
  grep -q "#define $wanted 1" "$components" || { echo "ERROR: $wanted missing"; exit 1; }
done
for unwanted in CONFIG_LIBX264_ENCODER CONFIG_LIBX265_ENCODER CONFIG_AAC_ENCODER; do
  grep -q "#define $unwanted 0" "$components" || { echo "ERROR: $unwanted must not be built"; exit 1; }
done

(cd "$SRC/ffmpeg" && make -j "$JOBS" && make install)

rm -rf "$OUT/include" "$OUT/share" "$OUT/lib/pkgconfig"
mkdir -p "$OUT/licenses"
cp "$SRC/ffmpeg/COPYING.LGPLv2.1" "$OUT/licenses/ffmpeg-COPYING.LGPLv2.1"
cp "$SRC/ffmpeg/LICENSE.md" "$OUT/licenses/ffmpeg-LICENSE.md"
sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$config" > "$OUT/licenses/ffmpeg-configure-line.txt"

rm -rf "$WORK"
touch "$OUT/.complete"
du -sh "$OUT"
