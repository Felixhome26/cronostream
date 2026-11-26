#!/usr/bin/env bash
# macOS build for the machine's own architecture (run it on an Apple
# Silicon runner for aarch64, on an Intel runner for x86_64). Runs on
# macOS 11 and later.
#   brew install nasm cmake pkg-config
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

export MACOSX_DEPLOYMENT_TARGET=11.0
case "$(uname -m)" in
  arm64) ARCH=aarch64; VPX_TARGET=arm64-darwin20-gcc ;;
  x86_64) ARCH=x86_64; VPX_TARGET=x86_64-darwin20-gcc ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac
fetch_sources

cmake -S "$SRC/opus" -B "$WORK/build-opus" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=$MACOSX_DEPLOYMENT_TARGET \
  -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF
cmake --build "$WORK/build-opus" -j "$JOBS"
cmake --install "$WORK/build-opus"

(cd "$SRC/libvpx" && ./configure --target=$VPX_TARGET --prefix="$PREFIX" \
  --enable-static --disable-shared --disable-examples --disable-tools --disable-docs --disable-unit-tests \
  && make -j "$JOBS" && make install)

(cd "$SRC/ffmpeg" && ./configure --prefix="$WORK/ffmpeg-out" \
  --extra-cflags="-I$PREFIX/include -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET" \
  --extra-ldflags="-L$PREFIX/lib -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET" \
  --enable-videotoolbox --enable-audiotoolbox \
  $(ffmpeg_common_flags))
verify_config CONFIG_H264_VIDEOTOOLBOX_ENCODER CONFIG_AAC_AT_ENCODER CONFIG_AVFOUNDATION_INDEV
(cd "$SRC/ffmpeg" && make -j "$JOBS" && make install)

BIN="$WORK/ffmpeg-out/bin"
# Self-contained: nothing but Apple's own system libraries may be linked
# (a Homebrew library here would only exist on the build machine).
for tool in ffmpeg ffprobe; do
  if otool -L "$BIN/$tool" | tail -n +2 | grep -vE '^\s*(/System/Library/|/usr/lib/)'; then
    echo "ERROR: $tool links a non-system library"; exit 1
  fi
  codesign --force --sign - "$BIN/$tool"
done
"$BIN/ffmpeg" -hide_banner -encoders | grep -E 'h264_videotoolbox|aac_at|libvpx-vp9|libopus'

package "ffmpeg-macos-$ARCH" "$BIN"
