#!/bin/sh
# Builds the ready-to-use release packages, each with its own Node.js (checked against the
# SHA-256 list nodejs.org publishes). The release workflow runs this; it works on any Linux too.
# Usage: sh .github/build-packages.sh <version> [targets]   (default: all of them)
# Targets: win-x64 linux-x64 linux-arm64 darwin-arm64 darwin-x64. Packages land in dist/.
set -eu

version=$1
shift
targets=${*:-win-x64 linux-x64 linux-arm64 darwin-arm64 darwin-x64}
base="https://nodejs.org/dist/${NODE_LINE:-latest-v24.x}"
repo=$(pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p dist

curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"

for target in $targets; do
  case $target in
    win-x64) archive='win-x64\.zip' package=Ardite-win64.zip ;;
    linux-x64) archive='linux-x64\.tar\.xz' package=Ardite-linux-x64.tar.gz ;;
    linux-arm64) archive='linux-arm64\.tar\.xz' package=Ardite-linux-arm64.tar.gz ;;
    darwin-arm64) archive='darwin-arm64\.tar\.gz' package=Ardite-macos-arm64.tar.gz ;;
    darwin-x64) archive='darwin-x64\.tar\.gz' package=Ardite-macos-x64.tar.gz ;;
    *) echo "unknown target: $target" >&2; exit 1 ;;
  esac

  # Node.js for this system, checked
  file=$(grep -oE "node-v[0-9.]+-$archive" "$work/SHASUMS256.txt" | head -1)
  echo "$target: $file"
  curl -fsSL "$base/$file" -o "$work/$file"
  (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  mkdir -p "$work/node-$target"
  case $file in
    *.zip) unzip -q "$work/$file" -d "$work/node-$target" ;;
    *) tar -xf "$work/$file" -C "$work/node-$target" ;;
  esac
  node_dir=$(find "$work/node-$target" -mindepth 1 -maxdepth 1 -type d | head -1)

  # Ardite itself: the same files everywhere, plus the launchers for that system
  out="$work/$target/Ardite"
  mkdir -p "$out/runtime" "$out/scripts"
  cp -r public lib ./*.js package.json LICENSE README.md "$out/"
  rm -rf "$out/public/vendor"
  cp scripts/update.mjs "$out/scripts/"
  cp "$node_dir/LICENSE" "$out/runtime/LICENSE"
  if [ "$target" = win-x64 ]; then
    cp ./*.bat ardite.cmd "$out/"
    cp scripts/start-hidden.vbs "$out/scripts/"
    cp "$node_dir/node.exe" "$out/runtime/"
  else
    cp ardite "$out/"
    cp "$node_dir/bin/node" "$out/runtime/"
    chmod 755 "$out/ardite" "$out/runtime/node"
  fi
  sed -i -E "s/\"version\": \"[^\"]+\"/\"version\": \"$version\"/" "$out/package.json"
  # every file in the package, so an update can remove what a newer version no longer has
  (cd "$out" && find . -type f | sed 's|^\./||' | LC_ALL=C sort > files.txt)

  rm -f "dist/$package"
  if [ "$target" = win-x64 ]; then
    (cd "$work/$target" && zip -qr "$repo/dist/$package" Ardite)
  else
    tar -czf "dist/$package" -C "$work/$target" Ardite
  fi
done

ls -lh dist
