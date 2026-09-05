#!/usr/bin/env bash
# Copy the Jevin scythe PNG into public/art/.
# Rainbow Friends now use meadow/horror JPEG portraits (not the old rf-*.png set).
# Drop the file into rainbow-friends/ first (cloud agents sometimes miss attachments).
# Copy exact bytes only — do not re-encode, redraw, or knock out black backgrounds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/rainbow-friends"
DEST="$ROOT/public/art"

need=(
  jevin-scythe.png
)

missing=0
for f in "${need[@]}"; do
  if [[ ! -f "$SRC/$f" ]]; then
    echo "MISSING: $SRC/$f"
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  echo "Place the exact PNG in rainbow-friends/ then re-run."
  exit 1
fi

mkdir -p "$DEST"
for f in "${need[@]}"; do
  cp -f "$SRC/$f" "$DEST/$f"
  echo "copied $f ($(wc -c < "$DEST/$f") bytes)"
done
echo "Done. Commit public/art/jevin-scythe.png with exact bytes (no re-encode)."
