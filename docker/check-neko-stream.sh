#!/usr/bin/env bash
set -euo pipefail
[[ "${STREAMING_BACKEND:-neko}" == neko ]] || exit 0
CHECK_LOG=/tmp/baka-inu-neko-check.log
: > "$CHECK_LOG"
write_report() {
  python3 - "$1" "$2" "$CHECK_LOG" <<'PY'
import datetime, json, os, sys
status, reason, logfile = sys.argv[1:]
try:
    diagnostics = open(logfile, errors='replace').read()[-12000:]
except OSError:
    diagnostics = ''
result = dict(status=status, reason=reason, encoder='vp8enc (software)', requested='neko',
              checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), diagnostics=diagnostics)
with open('/tmp/baka-inu-hardware.json.tmp', 'w') as output:
    json.dump(result, output)
os.replace('/tmp/baka-inu-hardware.json.tmp', '/tmp/baka-inu-hardware.json')
PY
}
write_report checking 'Waiting for the Neko desktop and audio capture check'
for attempt in 1 2 3 4 5; do
  echo "Checking Neko desktop VP8 encoding and audio (attempt $attempt/5)"
  if timeout --kill-after=2 15 gst-launch-1.0 -q \
    ximagesrc display-name="${DISPLAY:-:99.0}" num-buffers=10 use-damage=false \
    '!' video/x-raw,framerate=30/1 '!' videoconvert '!' video/x-raw,format=I420 \
    '!' vp8enc deadline=1 cpu-used=4 threads=4 '!' fakesink >"$CHECK_LOG" 2>&1 \
    && timeout --kill-after=2 10 ffmpeg -hide_banner -loglevel error \
      -f pulse -i "${STREAM_AUDIO_MONITOR:-audio_output.monitor}" -t 0.5 -f null - >>"$CHECK_LOG" 2>&1; then
    write_report passed 'Neko desktop VP8 encoding and audio capture checks passed'
    echo 'Neko startup checks passed (software VP8 encoding)'
    exit 0
  fi
  cat "$CHECK_LOG" >&2
  [[ "$attempt" == 5 ]] || sleep 2
done
write_report failed 'Neko desktop encoding or audio capture check failed; see diagnostics'
echo 'Neko startup checks failed; inspect Hardware and startup checks in the admin panel' >&2
exit 1
