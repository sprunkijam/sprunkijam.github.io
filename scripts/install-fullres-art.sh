#!/usr/bin/env bash
# Copy attached full-res JPEGs into public/art/ as-is (no recompress / resize).
# Looks in /workspace/art-in first, then any folder passed as $1.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="${1:-/workspace/art-in}"
dest="$root/public/art"
files=(
  intro-ring-landscape.jpeg
  intro-ring-portrait.jpeg
  intro-black-vineria-landscape.jpeg
  intro-black-vineria-portrait.jpeg
  bg-phase1-landscape.jpeg
  bg-phase1-portrait.jpeg
)
if [[ ! -d "$src" ]]; then
  echo "no source folder: $src" >&2
  exit 1
fi
for f in "${files[@]}"; do
  if [[ ! -f "$src/$f" ]]; then
    echo "missing $src/$f" >&2
    exit 1
  fi
  cp -f -- "$src/$f" "$dest/$f"
done
# Legacy names stay the landscape default so old links keep working.
cp -f -- "$dest/intro-ring-landscape.jpeg" "$dest/intro-ring.jpeg"
cp -f -- "$dest/intro-black-vineria-landscape.jpeg" "$dest/intro-black-vineria.jpeg"
echo "copied ${#files[@]} originals into $dest (legacy names = landscape)"
