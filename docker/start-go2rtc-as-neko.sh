#!/usr/bin/env bash
set -euo pipefail

GPU_DEVICE_GIDS="${GPU_DEVICE_GIDS:-$(id -G neko | tr ' ' ',')}"
echo "Starting go2rtc as neko with supplementary device groups: $GPU_DEVICE_GIDS"
exec setpriv \
  --reuid="$(id -u neko)" \
  --regid="$(id -g neko)" \
  --groups="$GPU_DEVICE_GIDS" \
  -- /bin/bash /usr/local/bin/start-go2rtc
