#!/usr/bin/env bash
set -euo pipefail

GPU_DEVICE_GIDS="${GPU_DEVICE_GIDS:-$(id -G neko | tr ' ' ',')}"
export MEDIABRIDGE_SMB_CONFIG_DIR="${MEDIABRIDGE_SMB_CONFIG_DIR:-${ROOM_DATA_DIR:-/data/room}}"
export MEDIABRIDGE_SMB_ROOM_PORT="${MEDIABRIDGE_SMB_ROOM_PORT:-8081}"
echo "Starting MediaBridge as neko with supplementary device groups: $GPU_DEVICE_GIDS"
exec setpriv \
  --reuid="$(id -u neko)" \
  --regid="$(id -g neko)" \
  --groups="$GPU_DEVICE_GIDS" \
  -- /usr/local/bin/mediabridge --bind 127.0.0.1:8765
