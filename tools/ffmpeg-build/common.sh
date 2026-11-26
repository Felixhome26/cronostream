#!/usr/bin/env bash
# Shared by build-windows.sh and build-macos.sh: fetching the sources, the
# ffmpeg configure flags that make the build LGPL and patent-conscious, the
# checks that prove it, and packaging with all license texts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$HERE/versions.env"

WORK="${WORK:-$PWD/work}"
PREFIX="$WORK/prefix"
SRC="$WORK/src"
OUT="${OUT:-$PWD/dist}"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
mkdir -p "$PREFIX" "$SRC" "$OUT"

# Only our own static libraries are visible to configure — never whatever
# the build machine happens to have installed (that would link GPL or
# non-redistributable libraries in by accident).
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH=""

fetch_sources() {
  [ -d "$SRC/ffmpeg" ] || git clone --depth 1 --branch "$FFMPEG_VERSION" https://github.com/FFmpeg/FFmpeg.git "$SRC/ffmpeg"
  [ -d "$SRC/libvpx" ] || git clone --depth 1 --branch "$LIBVPX_VERSION" https://github.com/webmproject/libvpx.git "$SRC/libvpx"
  [ -d "$SRC/opus" ] || git clone --depth 1 --branch "$OPUS_VERSION" https://github.com/xiph/opus.git "$SRC/opus"
  [ -d "$SRC/zlib" ] || git clone --depth 1 --branch "$ZLIB_VERSION" https://github.com/madler/zlib.git "$SRC/zlib"
}

# ffmpeg's own encoders for formats that are (or may still be) covered by
# patent pools. CronoStream never uses them: AAC/H.264 come from the
# operating system's licensed encoders, everything else is VP9/Opus. Not
# shipping them at all keeps the distributed binary clean.
DISABLED_ENCODERS="aac,ac3,ac3_fixed,eac3,dca,truehd,mlp,mpeg4,msmpeg4v2,msmpeg4v3,wmv1,wmv2,wmav1,wmav2,hevc_mf,ac3_mf,mp3_mf"

# Decoders are an allowlist. Video thumbnails on Windows/macOS come from the
# operating system's licensed decoders (native_thumb.rs); this ffmpeg reads
# what the webcam/microphone deliver (raw, MJPEG, PCM), serves as a
# thumbnail fallback, and converts old recordings the webview can't play
# (playback_compat.rs) — hence the second line: the formats of 1990s/2000s
# cameras, dictation devices and Windows PCs (ADPCM/GSM WAVs, WMA/WMV,
# DivX/MS-MPEG4 AVIs, Cinepak/Indeo, QuickTime, Flash video, AMR memos).
# H.264, HEVC, AAC and AC-3 stay absent: the webviews play those themselves.
ENABLED_DECODERS="rawvideo,mjpeg,jpegls,png,bmp,gif,tiff,webp,vp8,vp9,libvpx_vp8,libvpx_vp9,theora,mpeg1video,mpeg2video,mp1,mp2,mp3,mp3float,opus,libopus,vorbis,flac,alac,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_f64le,pcm_mulaw,pcm_alaw"
ENABLED_DECODERS="$ENABLED_DECODERS,adpcm_ima_wav,adpcm_ms,adpcm_ima_qt,adpcm_yamaha,adpcm_g726,adpcm_swf,gsm,gsm_ms,truespeech,g723_1,g729,wmav1,wmav2,amrnb,amrwb,qdm2,nellymoser,ra_144,ra_288,cook,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,wmv1,wmv2,wmv3,vc1,h263,h263p,flv,svq1,cinepak,indeo2,indeo3,indeo4,indeo5,msvideo1,msrle,qtrle,rpza,smc,dvvideo,mjpegb,rv10,rv20"

# Common configure flags. No --enable-gpl, no --enable-nonfree: the result
# is LGPL 2.1+, which `verify_license` below checks rather than assumes.
# No hwaccels: the D3D11/DXVA2/VideoToolbox ones "select" the H.264 and
# HEVC decoders and would pull them back in past the allowlist.
ffmpeg_common_flags() {
  echo --enable-static --disable-shared \
    --pkg-config-flags=--static \
    --disable-ffplay --disable-doc --disable-network \
    --disable-sdl2 --disable-xlib --disable-libxcb --disable-lzma \
    --enable-libvpx --enable-libopus \
    --disable-encoder="$DISABLED_ENCODERS" \
    --disable-decoders --enable-decoder="$ENABLED_DECODERS" \
    --disable-hwaccels
}

# Fails the build unless config.h says LGPL and the encoders stream
# relies on are in while the excluded ones are out.
verify_config() {
  local config="$SRC/ffmpeg/config.h"
  grep -q '#define FFMPEG_LICENSE "LGPL version 2.1 or later"' "$config" || {
    echo "ERROR: build is not LGPL 2.1+"; grep FFMPEG_LICENSE "$config"; exit 1; }
  for wanted in "$@" CONFIG_LIBVPX_VP9_ENCODER CONFIG_LIBVPX_VP8_ENCODER CONFIG_LIBOPUS_ENCODER; do
    grep -q "#define $wanted 1" "$SRC/ffmpeg/config_components.h" || { echo "ERROR: $wanted missing"; exit 1; }
  done
  for wanted in CONFIG_MJPEG_DECODER CONFIG_RAWVIDEO_DECODER CONFIG_PCM_S16LE_DECODER CONFIG_PCM_F32LE_DECODER \
      CONFIG_ADPCM_IMA_WAV_DECODER CONFIG_WMAV2_DECODER CONFIG_MSMPEG4V3_DECODER CONFIG_MPEG4_DECODER CONFIG_CINEPAK_DECODER; do
    grep -q "#define $wanted 1" "$SRC/ffmpeg/config_components.h" || { echo "ERROR: $wanted missing"; exit 1; }
  done
  for unwanted in CONFIG_AAC_ENCODER CONFIG_LIBX264_ENCODER CONFIG_LIBX265_ENCODER CONFIG_LIBFDK_AAC_ENCODER \
      CONFIG_H264_DECODER CONFIG_HEVC_DECODER CONFIG_AAC_DECODER CONFIG_AC3_DECODER CONFIG_EAC3_DECODER; do
    grep -q "#define $unwanted 0" "$SRC/ffmpeg/config_components.h" || { echo "ERROR: $unwanted must not be built"; exit 1; }
  done
}

# Zip: the two tools, every license that applies, and where the exact
# source can be found (LGPL section 6 / BSD attribution).
package() {
  local name="$1" bindir="$2" exe="${3:-}"
  local stage="$WORK/stage/$name"
  rm -rf "$stage"; mkdir -p "$stage/licenses"
  cp "$bindir/ffmpeg$exe" "$bindir/ffprobe$exe" "$stage/"
  cp "$SRC/ffmpeg/COPYING.LGPLv2.1" "$stage/licenses/ffmpeg-COPYING.LGPLv2.1"
  cp "$SRC/ffmpeg/LICENSE.md" "$stage/licenses/ffmpeg-LICENSE.md"
  cp "$SRC/libvpx/LICENSE" "$stage/licenses/libvpx-LICENSE"
  cp "$SRC/libvpx/PATENTS" "$stage/licenses/libvpx-PATENTS"
  cp "$SRC/opus/COPYING" "$stage/licenses/opus-COPYING"
  # Only the Windows build links our own zlib (build-windows.sh).
  [ "$exe" = .exe ] && cp "$SRC/zlib/LICENSE" "$stage/licenses/zlib-LICENSE"
  cat > "$stage/SOURCES.txt" <<TXT
This ffmpeg build is part of CronoStream and is licensed under the
GNU Lesser General Public License, version 2.1 or later (see licenses/).
It is a separate program; you may replace it with your own build.

Exact sources:
  ffmpeg $FFMPEG_VERSION  https://github.com/FFmpeg/FFmpeg/tree/$FFMPEG_VERSION
  libvpx $LIBVPX_VERSION  https://github.com/webmproject/libvpx/tree/$LIBVPX_VERSION  (BSD-3-Clause)
  opus   $OPUS_VERSION   https://github.com/xiph/opus/tree/$OPUS_VERSION  (BSD-3-Clause)
  zlib   $ZLIB_VERSION   https://github.com/madler/zlib/tree/$ZLIB_VERSION  (zlib license; Windows build only)

The complete corresponding source — these exact trees plus the scripts
that built this binary — is provided as ffmpeg-sources.zip alongside
CronoStream (see CronoStream's About dialog for where to get it).

ffmpeg configure line:
$(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/  \1/p' "$SRC/ffmpeg/config.h")
TXT
  (cd "$WORK/stage" && rm -f "$OUT/$name.zip" && zip -qr "$OUT/$name.zip" "$name")
  echo "Packaged $OUT/$name.zip"
}
