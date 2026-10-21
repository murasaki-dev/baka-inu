#!/usr/bin/env bash
set -euo pipefail

BACKEND="${STREAMING_BACKEND:-neko}"
STATE_FILE="${ROOM_DATA_DIR:-/data/room}/room.json"

if [[ -f "$STATE_FILE" ]]; then
  STORED_BACKEND="$(python3 - "$STATE_FILE" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], encoding='utf-8') as source:
        value = json.load(source).get('streamingBackend', '')
    print(value if value in ('neko', 'go2rtc') else '')
except (OSError, ValueError, AttributeError):
    print('')
PY
)"
  [[ -z "$STORED_BACKEND" ]] || BACKEND="$STORED_BACKEND"
fi

if [[ "$BACKEND" != neko && "$BACKEND" != go2rtc ]]; then
  echo "STREAMING_BACKEND must be neko or go2rtc" >&2
  exit 1
fi
export STREAMING_BACKEND="$BACKEND"

# Docker adds host device groups to the container process, but supervisord's
# `user=` directive drops those supplementary groups. Pass a merged group list
# to the MediaBridge and go2rtc privilege-drop wrappers so both services keep
# neko's audio groups and every numeric group that owns a DRI device.
GPU_DEVICE_GIDS="$(
  {
    id -G neko
    for device in /dev/dri/*; do
      if [[ -c "$device" ]]; then stat -c '%g' "$device"; fi
    done
  } | tr ' ' '\n' | sed '/^$/d' | sort -nu | paste -sd, -
)"
if [[ -z "$GPU_DEVICE_GIDS" ]]; then
  GPU_DEVICE_GIDS="$(id -G neko | tr ' ' ',')"
fi
export GPU_DEVICE_GIDS
echo "Supplementary device groups configured for MediaBridge and go2rtc: $GPU_DEVICE_GIDS"

# Keep LibreWolf and the streamed desktop on the same, single Openbox workspace.
python3 - <<'PY'
from pathlib import Path
import re

config = Path('/etc/xdg/openbox/rc.xml')
if config.is_file():
    text = config.read_text()
    def one_desktop(match):
        section = match.group(1)
        section, count = re.subn(r'<number>\s*\d+\s*</number>', '<number>1</number>', section, count=1)
        return '<desktops>' + section + '</desktops>'
    text = re.sub(r'<desktops>(.*?)</desktops>', one_desktop, text, count=1, flags=re.S)
    config.write_text(text)
PY

python3 - "$BACKEND" <<'PY'
from pathlib import Path
import re
import sys

selected = sys.argv[1]
root = Path('/etc/neko')
found = set()
for path in root.rglob('*.conf'):
    lines = path.read_text(errors='ignore').splitlines(keepends=True)
    changed = False
    index = 0
    while index < len(lines):
        match = re.match(r'^\s*\[program:(neko|go2rtc)\]\s*$', lines[index], re.I)
        if not match:
            index += 1
            continue
        name = match.group(1).lower()
        found.add(name)
        end = next((i for i in range(index + 1, len(lines)) if lines[i].lstrip().startswith('[')), len(lines))
        desired = 'true' if name == selected else 'false'
        auto = next((i for i in range(index + 1, end) if re.match(r'^\s*autostart\s*=', lines[i], re.I)), None)
        if auto is None:
            lines.insert(index + 1, f'autostart={desired}\n')
            changed = True
            end += 1
        elif not re.match(rf'^\s*autostart\s*=\s*{desired}\s*$', lines[auto], re.I):
            lines[auto] = re.sub(r'(autostart\s*=\s*).*', rf'\g<1>{desired}', lines[auto], flags=re.I)
            changed = True
        index = end
    if changed:
        path.write_text(''.join(lines))

missing = {'neko', 'go2rtc'} - found
if missing:
    raise SystemExit(f"Missing supervisor program configuration(s): {', '.join(sorted(missing))}")
PY

echo "Starting Baka-Inu with $BACKEND desktop streaming"
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf
