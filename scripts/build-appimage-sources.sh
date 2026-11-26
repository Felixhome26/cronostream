#!/usr/bin/env bash
# Packs the distribution source packages of everything bundled into the Linux
# AppImage (GTK, WebKitGTK, GStreamer, …) into `appimage-sources.tar`, which
# goes next to the AppImage on the download page: LGPL/GPL ask for the
# corresponding source to be offered alongside the binaries.
#
# The package list comes from the AppDir, exactly as collect-appimage-licenses.mjs
# finds it (bundled file → dpkg package → source package), with the versions
# installed now. So run this on the build machine right after the AppImage
# build, before any `apt upgrade`.
#
# No root needed and nothing on the system changes: apt runs with its own
# sources list (deb-src for Ubuntu noble + Linux Mint xia) and its own state
# directory inside the work directory. `apt-get source --download-only`
# fetches .dsc + tarballs only, nothing is unpacked or built.
#
#   scripts/build-appimage-sources.sh [work directory] [AppDir]
#   (defaults: ./work-appimage-sources, the AppDir of the last `npm run build:appimage`)
#
# Result: <work>/appimage-sources.tar with sources/<package>/… and SOURCES.txt.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(realpath -m "${1:-$PWD/work-appimage-sources}")"
APPDIR="${2:-}"
APT="$WORK/apt"
STAGE="$WORK/stage/appimage-sources"
mkdir -p "$APT/lists/partial" "$APT/cache/archives/partial" "$APT/sources.list.d" "$APT/preferences.d" "$STAGE/sources"

cat > "$APT/sources.list" <<'EOF'
deb-src [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse
deb-src [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse
deb-src [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://security.ubuntu.com/ubuntu noble-security main restricted universe multiverse
deb-src http://packages.linuxmint.com xia main upstream import backport
EOF

apt_opts=(
  -o "Dir::Etc::sourcelist=$APT/sources.list"
  -o "Dir::Etc::sourceparts=$APT/sources.list.d"
  -o "Dir::Etc::preferencesparts=$APT/preferences.d"
  -o "Dir::State=$APT"
  -o "Dir::State::lists=$APT/lists"
  -o "Dir::State::status=/var/lib/dpkg/status"
  -o "Dir::Cache=$APT/cache"
  -o "Debug::NoLocking=1"
)
apt-get "${apt_opts[@]}" update

# package, version, source, source version — one line per bundled package.
node "$ROOT/scripts/collect-appimage-licenses.mjs" ${APPDIR:+"$APPDIR"} --packages-tsv > "$WORK/packages.tsv"
cut -f3,4 "$WORK/packages.tsv" | sort -u > "$WORK/sources.tsv"

# apt's index only knows the newest version of each pocket. An older one
# (the build machine had not upgraded yet) is still on Launchpad, which
# keeps every version ever published.
from_launchpad() {
  local src="$1" ver="$2" dir="$3" api urls
  api="https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedSources&source_name=$src&version=$ver&exact_match=true"
  urls="$(curl -fsSL "$api" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const entry = JSON.parse(s).entries?.[0];
      if (entry) console.log(entry.self_link);
    });')" || return 1
  [ -n "$urls" ] || return 1
  curl -fsSL "$urls?ws.op=sourceFileUrls" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).join("\n")));' \
    > "$dir/.urls" || return 1
  [ -s "$dir/.urls" ] || return 1
  (cd "$dir" && while read -r url; do curl -fsSLO "$url" || exit 1; done < .urls) || return 1
  rm -f "$dir/.urls"
  ls "$dir"/*.dsc >/dev/null 2>&1
}

missing=()
while IFS=$'\t' read -r src ver; do
  dir="$STAGE/sources/$src"
  # Kept from an earlier run only if it is exactly this version (no epoch in file names).
  if [ -f "$dir/${src}_${ver#*:}.dsc" ]; then continue; fi
  rm -rf "$dir"; mkdir -p "$dir"
  if ! (cd "$dir" && apt-get "${apt_opts[@]}" source --download-only "$src=$ver" </dev/null) &&
     ! { echo "Not in the apt index, trying Launchpad: $src $ver"; from_launchpad "$src" "$ver" "$dir"; }; then
    missing+=("$src=$ver")
    rm -rf "$dir"
  fi
done < "$WORK/sources.tsv"

{
  echo "Source packages of the libraries bundled into the CronoStream Linux AppImage"
  echo "(Ubuntu 24.04 \"noble\"; xapp from Linux Mint 22 \"xia\")."
  echo "Each folder in sources/ holds the Debian source package: unpack with \`dpkg-source -x <name>.dsc\`."
  echo "CronoStream's own ffmpeg is not in here: its source is ffmpeg-sources.zip."
  echo
  printf '%-40s %s\n' "SOURCE PACKAGE" "VERSION"
  while IFS=$'\t' read -r src ver; do printf '%-40s %s\n' "$src" "$ver"; done < "$WORK/sources.tsv"
  echo
  echo "Binary packages taken from them:"
  sort "$WORK/packages.tsv" | while IFS=$'\t' read -r pkg pver src ver; do echo "  $pkg $pver (source $src $ver)"; done
  if [ ${#missing[@]} -gt 0 ]; then echo; echo "NOT INCLUDED (download failed): ${missing[*]}"; fi
} > "$STAGE/SOURCES.txt"

# Folders of source packages no longer bundled.
for dir in "$STAGE/sources"/*/; do
  grep -q "^$(basename "$dir")"$'\t' "$WORK/sources.tsv" || rm -rf "$dir"
done

# Tarballs are compressed already: a plain tar.
(cd "$WORK/stage" && tar -cf "$WORK/appimage-sources.tar" appimage-sources)
echo "Packaged $WORK/appimage-sources.tar ($(du -h "$WORK/appimage-sources.tar" | cut -f1)), $(($(wc -l < "$WORK/sources.tsv") - ${#missing[@]})) of $(wc -l < "$WORK/sources.tsv") source packages"
if [ ${#missing[@]} -gt 0 ]; then echo "Missing: ${missing[*]}" >&2; exit 1; fi
