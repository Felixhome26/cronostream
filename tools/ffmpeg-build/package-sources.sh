#!/usr/bin/env bash
# Packs the complete corresponding source of the ffmpeg build: the exact
# upstream trees that were compiled (ffmpeg, libvpx, opus, zlib — without their
# git history) plus these build scripts. This is what LGPL 2.1 section 6
# asks to accompany the binaries with; it goes next to the installers on
# the download page (or on request, see docs/lizenzpruefung.md).
set -euo pipefail
# A fresh checkout of its own: the build trees contain object files.
export WORK="$PWD/work-sources"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
fetch_sources

stage="$WORK/stage/ffmpeg-sources"
rm -rf "$stage"; mkdir -p "$stage/build-scripts"
for project in ffmpeg libvpx opus zlib; do
  rsync -a --exclude .git "$SRC/$project/" "$stage/$project/"
done
# The Linux AppImage's build (build-linux.sh) is a different ffmpeg version.
[ -d "$SRC/ffmpeg-linux" ] || git clone --depth 1 --branch "$FFMPEG_LINUX_VERSION" https://github.com/FFmpeg/FFmpeg.git "$SRC/ffmpeg-linux"
rsync -a --exclude .git "$SRC/ffmpeg-linux/" "$stage/ffmpeg-linux/"
cp "$HERE"/*.sh "$HERE"/versions.env "$HERE"/README.md "$stage/build-scripts/"
(cd "$WORK/stage" && rm -f "$OUT/ffmpeg-sources.zip" && zip -qr "$OUT/ffmpeg-sources.zip" ffmpeg-sources)
echo "Packaged $OUT/ffmpeg-sources.zip"
