#!/usr/bin/env bash
set -euo pipefail

CONFIG=/opt/room/go2rtc.yaml
SCREEN="${DESKTOP_SCREEN:-1280x720}"
WIDTH="${SCREEN%x*}"
HEIGHT="${SCREEN#*x}"
if [[ ! "$WIDTH" =~ ^[0-9]{3,4}$ || ! "$HEIGHT" =~ ^[0-9]{3,4}$ ]]; then
  echo "Invalid DESKTOP_SCREEN: $SCREEN" >&2
  exit 1
fi

ENCODER="libx264"
FILTER="format=yuv420p"
ENCODER_ARGS="-preset ultrafast -tune zerolatency -profile:v baseline"
HW_ARGS=""
VAAPI_DEVICE=""
DEFAULT_MONITOR="${STREAM_AUDIO_MONITOR:-audio_output.monitor}"
log() { printf '%s go2rtc-startup: %s\n' "$(date -Is 2>/dev/null || date)" "$*" >&2; }
FALLBACK_REASON=""
CHECK_LOG=/tmp/baka-inu-capture-check.log
PROBE_LOG=/tmp/baka-inu-encoder-probes.log
: > "$PROBE_LOG"
: > "$CHECK_LOG"
write_hardware_report() {
  python3 - "$1" "${2:-}" "$ENCODER" "${STREAM_ENCODER:-auto}" "$VAAPI_DEVICE" "$FALLBACK_REASON" "$CHECK_LOG" <<'PY'
import datetime, glob, json, os, sys
status, reason, encoder, requested, device, fallback, logfile = sys.argv[1:]
try:
    diagnostics = (open('/tmp/baka-inu-encoder-probes.log', errors='replace').read() + '\n' + open(logfile, errors='replace').read())[-16000:]
except OSError:
    diagnostics = ''
try:
    rate_mode = open('/tmp/baka-inu-vaapi-rate-mode').read().strip() if encoder == 'h264_vaapi' else None
except OSError:
    rate_mode = None
report = dict(status=status, reason=reason or None, encoder=encoder, requested=requested,
              device=(device or None) if encoder == 'h264_vaapi' else None, fallback_reason=fallback or None, rate_mode=rate_mode,
              device_access={p: os.access(p, os.R_OK | os.W_OK) for p in glob.glob('/dev/dri/renderD*')},
              process_groups=os.getgroups(),
              checked_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), diagnostics=diagnostics)
target = '/tmp/baka-inu-hardware.json'
with open(target + '.tmp', 'w') as output:
    json.dump(report, output)
os.replace(target + '.tmp', target)
PY
}
write_hardware_report checking 'Selecting encoder and checking desktop capture'

log "Starting encoder selection: requested=${STREAM_ENCODER:-auto}, user=$(id -un) uid=$(id -u) groups=$(id -G), screen=${SCREEN}"
rm -f /tmp/baka-inu-vaapi-rate-mode
log "FFmpeg: $(ffmpeg -hide_banner -version 2>/dev/null | head -n 1 || echo unavailable)"
for variable in LIBVA_DRIVER_NAME LIBVA_DRIVERS_PATH; do
  if [[ -n "${!variable:-}" ]]; then log "$variable=${!variable}"; else log "$variable is unset (using driver auto-detection)"; fi
done
if [[ -d /dev/dri ]]; then
  ls -ln /dev/dri >&2 || true
else
  log "/dev/dri is missing"
fi

vaapi_encoder_works() {
  local encoders
  encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
  grep -q h264_vaapi <<<"$encoders" || {
    echo "FFmpeg was built without the h264_vaapi encoder" >&2
    grep -E 'h264_(vaapi|nvenc)' <<<"$encoders" >&2 || echo "No matching H.264 hardware encoders listed" >&2
    return 1
  }
  local found_device=false
  local probe_log=/tmp/baka-inu-vaapi-probe.log
  for device in /dev/dri/renderD*; do
    [[ -c "$device" ]] || continue
    found_device=true
    if timeout --kill-after=2 15 ffmpeg -hide_banner -loglevel verbose -vaapi_device "$device" \
      -f lavfi -i color=c=black:s=320x240:r=1 -frames:v 3 -an \
      -vf format=nv12,hwupload -c:v h264_vaapi -profile:v constrained_baseline \
      -rc_mode CQP -qp 24 -f null - \
      >/dev/null 2>"$probe_log"; then
      VAAPI_DEVICE="$device"
      printf '%s\n' "$VAAPI_DEVICE" > /tmp/baka-inu-vaapi-device
      if timeout --kill-after=2 15 ffmpeg -hide_banner -loglevel error -vaapi_device "$device" \
        -f lavfi -i color=c=black:s=320x240:r=1 -frames:v 3 -an \
        -vf format=nv12,hwupload -c:v h264_vaapi -profile:v constrained_baseline \
        -rc_mode VBR -b:v 1000k -maxrate 1000k -bufsize 2000k -f null - \
        >/dev/null 2>"$probe_log"; then
        printf 'VBR\n' > /tmp/baka-inu-vaapi-rate-mode
        log "VA-API bitrate control test encode succeeded with device=$device"
      else
        printf 'CQP\n' > /tmp/baka-inu-vaapi-rate-mode
        log "VA-API device supports CQP only; bitrate target will be approximated by quality level"
      fi
      log "VA-API H.264 test encode succeeded with device=$device"
      rm -f "$probe_log"
      return 0
    fi
    echo "VA-API H.264 encoder probe failed for $device (details captured for final startup report)" >&2
    cat "$probe_log" >&2
  done
  if [[ "$found_device" == false ]]; then
    echo "No /dev/dri/renderD* device is available to the encoder process" >&2
  fi
  rm -f "$probe_log"
  return 1
}
wait_for_vaapi_encoder() {
  local attempts=3
  local delay=2
  local attempt=1
  local last_log=/tmp/baka-inu-vaapi-startup.log
  if ! compgen -G '/dev/dri/renderD*' >/dev/null; then
    echo 'No render device was passed into the container' | tee -a "$PROBE_LOG" >&2
    return 1
  fi
  log "Checking VA-API H.264 encode support (up to $attempts attempts, ${delay}s apart)"
  while (( attempt <= attempts )); do
    if vaapi_encoder_works 2>"$last_log"; then
      cat "$last_log" | tee -a "$PROBE_LOG" >&2
      rm -f "$last_log"
      return 0
    fi
    if (( attempt < attempts )); then
      log "VA-API probe failed (attempt $attempt/$attempts); retrying in ${delay}s"
      sleep "$delay"
    fi
    ((attempt += 1))
  done
  log "VA-API probe failed after $attempts attempts. Final FFmpeg diagnostics follow:"
  cat "$last_log" | tee -a "$PROBE_LOG" >&2
  if command -v vainfo >/dev/null 2>&1; then
    log "vainfo diagnostics for available render devices:"
    for device in /dev/dri/renderD*; do
      [[ -c "$device" ]] || continue
      vainfo --display drm --device "$device" 2>&1 || true
    done
  else
    log "vainfo is not installed in this image; FFmpeg diagnostics above are authoritative for the probe"
  fi
  rm -f "$last_log"
  return 1
}
nvenc_encoder_works() {
  local nvenc_log=/tmp/baka-inu-nvenc-probe.log
  if timeout --kill-after=2 15 ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=320x240:r=1 \
      -frames:v 3 -an -c:v h264_nvenc -preset p1 -tune ll -profile:v baseline -f null - >/dev/null 2>"$nvenc_log"; then
    echo 'NVIDIA NVENC test encode passed' >> "$PROBE_LOG"
    return 0
  fi
  cat "$nvenc_log" >> "$PROBE_LOG"
  return 1
}
case "${STREAM_ENCODER:-auto}" in
  software) ;;
  auto)
    if nvenc_encoder_works; then
      ENCODER="h264_nvenc"
      ENCODER_ARGS="-preset p1 -tune ll -profile:v baseline"
      rm -f /tmp/baka-inu-vaapi-device
    elif wait_for_vaapi_encoder; then
      ENCODER="h264_vaapi"
      FILTER="format=nv12,hwupload"
      ENCODER_ARGS="-profile:v constrained_baseline"
      HW_ARGS="-vaapi_device $VAAPI_DEVICE"
    else
      FALLBACK_REASON="No hardware encoder passed its test encode; check GPU passthrough, permissions, and driver support."
      echo "No usable hardware encoder found; using libx264 software encoding" >&2
    fi
    ;;
  vaapi)
    if wait_for_vaapi_encoder; then
      ENCODER="h264_vaapi"
      FILTER="format=nv12,hwupload"
      ENCODER_ARGS="-profile:v constrained_baseline"
      HW_ARGS="-vaapi_device $VAAPI_DEVICE"
    else
      log "STREAM_ENCODER=vaapi requested, but VA-API failed its test encode; exiting so the failure is explicit"
      write_hardware_report failed 'Requested VA-API encoder did not pass its test encode'
      exit 1
    fi
    ;;
  nvenc)
    if nvenc_encoder_works; then
      ENCODER="h264_nvenc"
      FILTER="format=yuv420p"
      ENCODER_ARGS="-preset p1 -tune ll -profile:v baseline"
    else
      echo "STREAM_ENCODER=nvenc requested, but h264_nvenc is unavailable" >&2
      write_hardware_report failed 'Requested NVIDIA encoder did not pass its test encode'
      exit 1
    fi
    ;;
  *) write_hardware_report failed 'Invalid STREAM_ENCODER: choose auto, software, vaapi, or nvenc'; echo "STREAM_ENCODER must be auto, software, vaapi, or nvenc" >&2; exit 1 ;;
esac

printf '%s\n' "$ENCODER" > /tmp/baka-inu-stream-encoder
check_desktop_capture() {
  local attempt
  for attempt in 1 2 3; do
    log "Checking actual desktop capture, encoding, and audio (attempt $attempt/3)"
    if /usr/local/bin/start-desktop-stream --startup-check >"$CHECK_LOG" 2>&1; then
      cat "$CHECK_LOG" >&2
      return 0
    fi
    tail -n 35 "${ROOM_DATA_DIR:-/data/room}/desktop-stream.log" >>"$CHECK_LOG" 2>/dev/null || true
    cat "$CHECK_LOG" >&2
    cat "$CHECK_LOG" >> "$PROBE_LOG"
    [[ "$attempt" == 3 ]] || sleep 2
  done
  return 1
}
if ! check_desktop_capture; then
  if [[ "${STREAM_ENCODER:-auto}" == auto && "$ENCODER" != libx264 ]]; then
    FALLBACK_REASON="Hardware passed the synthetic encode but failed the desktop capture check. Using software encoding."
    log "$FALLBACK_REASON"
    ENCODER=libx264
    printf '%s\n' "$ENCODER" > /tmp/baka-inu-stream-encoder
    if ! check_desktop_capture; then
      write_hardware_report failed 'Desktop capture failed with both hardware and software encoding; see diagnostics'
      exit 1
    fi
  else
    write_hardware_report failed 'Desktop capture or audio check failed; see diagnostics'
    exit 1
  fi
fi
write_hardware_report passed 'Desktop capture produced video and audio with the selected stream settings'
echo "go2rtc desktop stream encoder: $ENCODER"

python3 - "$CONFIG" "$WIDTH" "$HEIGHT" "$ENCODER" "$FILTER" "$ENCODER_ARGS" "$HW_ARGS" "$DEFAULT_MONITOR" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
s = s.replace('1280x720', f'{sys.argv[2]}x{sys.argv[3]}')
s = s.replace('@VIDEO_FILTER@', sys.argv[5]).replace('@VIDEO_ENCODER@', sys.argv[4]).replace('@ENCODER_ARGS@', sys.argv[6]).replace('@HW_ARGS@', sys.argv[7])
s = s.replace('@DEFAULT_MONITOR@', sys.argv[8])
p.write_text(s)
PY

exec /usr/local/bin/go2rtc -config "$CONFIG"
