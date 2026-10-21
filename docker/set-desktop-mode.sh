#!/usr/bin/env bash
set -euo pipefail

SCREEN="${VIRTUAL_DESKTOP_SCREEN:-1280x720@30}"
SIZE="${SCREEN%@*}"
WIDTH="${SIZE%x*}"
HEIGHT="${SIZE#*x}"
RATE="${SCREEN#*@}"
[[ "$RATE" == "$SCREEN" ]] && RATE=30
if [[ ! "$WIDTH" =~ ^[0-9]{3,4}$ || ! "$HEIGHT" =~ ^[0-9]{3,4}$ || ! "$RATE" =~ ^[0-9]{2}$ ]]; then
  echo "Invalid VIRTUAL_DESKTOP_SCREEN: $SCREEN" >&2
  exit 1
fi

for _ in $(seq 1 60); do
  if MODES="$(xrandr --query 2>/dev/null)"; then break; fi
  sleep 0.5
done
if [[ -z "${MODES:-}" ]]; then
  echo 'X11 display did not become ready for resolution setup' >&2
  exit 1
fi

MODE="$(printf '%s\n' "$MODES" | awk -v wanted="${WIDTH}x${HEIGHT}_${RATE}." '$1 ~ ("^" wanted) { print $1; exit }')"
if [[ -z "$MODE" ]]; then MODE="$(printf '%s\n' "$MODES" | awk -v prefix="${WIDTH}x${HEIGHT}_" '$1 ~ ("^" prefix) { print $1; exit }')"; fi
OUTPUT="$(printf '%s\n' "$MODES" | awk '/ connected/{print $1; exit}')"
if [[ -n "$MODE" && -n "$OUTPUT" ]]; then
  xrandr --output "$OUTPUT" --mode "$MODE"
else
  xrandr --fb "${WIDTH}x${HEIGHT}"
fi
echo "X11 desktop size set to ${WIDTH}x${HEIGHT} (mode ${MODE:-framebuffer})"
