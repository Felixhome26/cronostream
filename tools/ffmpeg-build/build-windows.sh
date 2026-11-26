#!/usr/bin/env bash
# Windows x86_64 build, cross-compiled on Ubuntu with mingw-w64 (the usual
# way Windows ffmpeg builds are made). Windows on ARM runs it emulated.
#   sudo apt-get install mingw-w64 nasm cmake pkg-config zip git
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

HOST=x86_64-w64-mingw32
fetch_sources

# zlib for the PNG/TIFF decoders (Windows has no system zlib to link).
make -C "$SRC/zlib" -f win32/Makefile.gcc -j "$JOBS" PREFIX=$HOST- \
  BINARY_PATH="$PREFIX/bin" INCLUDE_PATH="$PREFIX/include" LIBRARY_PATH="$PREFIX/lib" install

cmake -S "$SRC/opus" -B "$WORK/build-opus" -G "Unix Makefiles" \
  -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER=$HOST-gcc -DCMAKE_RC_COMPILER=$HOST-windres \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DBUILD_SHARED_LIBS=OFF \
  -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF \
  -DOPUS_FORTIFY_SOURCE=OFF -DOPUS_STACK_PROTECTOR=OFF
cmake --build "$WORK/build-opus" -j "$JOBS"
cmake --install "$WORK/build-opus"

(cd "$SRC/libvpx" && CROSS=$HOST- ./configure --target=x86_64-win64-gcc --prefix="$PREFIX" \
  --enable-static --disable-shared --disable-examples --disable-tools --disable-docs --disable-unit-tests \
  && make -j "$JOBS" && make install)

(cd "$SRC/ffmpeg" && ./configure --prefix="$WORK/ffmpeg-out" \
  --arch=x86_64 --target-os=mingw32 --cross-prefix=$HOST- --pkg-config=pkg-config \
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib -static" \
  --enable-mediafoundation --enable-zlib \
  $(ffmpeg_common_flags))
verify_config CONFIG_H264_MF_ENCODER CONFIG_AAC_MF_ENCODER CONFIG_DSHOW_INDEV CONFIG_PNG_DECODER CONFIG_TIFF_DECODER
(cd "$SRC/ffmpeg" && make -j "$JOBS" && make install)

package ffmpeg-windows-x86_64 "$WORK/ffmpeg-out/bin" .exe
