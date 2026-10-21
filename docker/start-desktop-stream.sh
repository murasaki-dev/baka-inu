#!/usr/bin/env bash
set -euo pipefail

SCREEN="${DESKTOP_SCREEN:-1280x720}"
WIDTH="${SCREEN%x*}"
HEIGHT="${SCREEN#*x}"
if [[ ! "$WIDTH" =~ ^[0-9]{3,4}$ || ! "$HEIGHT" =~ ^[0-9]{3,4}$ ]]; then
  echo "Invalid DESKTOP_SCREEN: $SCREEN" >&2
  exit 1
fi

ENCODER="$(cat /tmp/baka-inu-stream-encoder 2>/dev/null || echo libx264)"
OUTPUT_SIZE="$(cat "${ROOM_DATA_DIR:-/data/room}/stream-output-resolution" 2>/dev/null || echo match)"
STREAM_BITRATE_KBPS="$(cat "${ROOM_DATA_DIR:-/data/room}/stream-bitrate-kbps" 2>/dev/null || echo 4000)"
if [[ ! "$STREAM_BITRATE_KBPS" =~ ^[0-9]+$ ]] || (( STREAM_BITRATE_KBPS < 500 || STREAM_BITRATE_KBPS > 12000 )); then
  STREAM_BITRATE_KBPS=4000
fi
HW_ARGS=()
ENCODER_ARGS=()
FILTER_ARGS=()
RATE_ARGS=(-b:v "${STREAM_BITRATE_KBPS}k" -maxrate "${STREAM_BITRATE_KBPS}k" -bufsize "$((STREAM_BITRATE_KBPS * 2))k")
case "$ENCODER" in
  h264_nvenc)
    ENCODER_ARGS=(-preset p1 -tune ll -profile:v baseline)
    RATE_ARGS=(-rc cbr -b:v "${STREAM_BITRATE_KBPS}k" -maxrate "${STREAM_BITRATE_KBPS}k" -bufsize "$((STREAM_BITRATE_KBPS * 2))k")
    ;;
  h264_vaapi)
    VAAPI_DEVICE="$(cat /tmp/baka-inu-vaapi-device 2>/dev/null || echo /dev/dri/renderD128)"
    HW_ARGS=(-vaapi_device "$VAAPI_DEVICE")
    FILTER_ARGS=(-vf format=nv12,hwupload)
    ENCODER_ARGS=(-profile:v constrained_baseline)
    # Some Intel drivers expose only CQP. Map the room-wide target to a
    # quality level on those devices; this reduces bitrate approximately,
    # though content complexity means it cannot guarantee a hard ceiling.
    case "$STREAM_BITRATE_KBPS" in
      500|1000) VAAPI_QP=36 ;;
      1500) VAAPI_QP=34 ;;
      2000|2500) VAAPI_QP=32 ;;
      3000|3500) VAAPI_QP=29 ;;
      4000|4500) VAAPI_QP=26 ;;
      5000|5500) VAAPI_QP=24 ;;
      6000|6500) VAAPI_QP=22 ;;
      7000|7500) VAAPI_QP=20 ;;
      *) VAAPI_QP=18 ;;
    esac
    VAAPI_RATE_MODE="$(cat /tmp/baka-inu-vaapi-rate-mode 2>/dev/null || echo CQP)"
    if [[ "$VAAPI_RATE_MODE" == VBR ]]; then
      RATE_ARGS=(-rc_mode VBR -b:v "${STREAM_BITRATE_KBPS}k" -maxrate "${STREAM_BITRATE_KBPS}k" -bufsize "$((STREAM_BITRATE_KBPS * 2))k")
    else
      RATE_ARGS=(-rc_mode CQP -qp "$VAAPI_QP")
    fi
    ;;
  *)
    ENCODER=libx264
    ENCODER_ARGS=(-preset ultrafast -tune zerolatency -profile:v baseline)
    ;;
esac

case "$OUTPUT_SIZE" in
  match) ;;
  854x480|640x360)
    if [[ "$ENCODER" == h264_vaapi ]]; then
      FILTER_ARGS=(-vf "format=nv12,hwupload,scale_vaapi=w=${OUTPUT_SIZE%x*}:h=${OUTPUT_SIZE#*x}")
    else
      FILTER_ARGS=(-vf "scale=${OUTPUT_SIZE%x*}:${OUTPUT_SIZE#*x},format=yuv420p")
    fi
    ;;
  *) echo "Invalid outgoing stream resolution: $OUTPUT_SIZE; using match" >&2 ;;
esac

if [[ "${1:-}" == "--startup-check" ]]; then
  CHECK_DIR="$(mktemp -d)"
  trap 'rm -rf "$CHECK_DIR"' EXIT
  export STREAM_CHECK_OUTPUT="$CHECK_DIR/sample.ts"
  timeout --kill-after=3 20 "$0" --capture-worker
  ffprobe -v error -count_packets -show_entries stream=codec_type,codec_name,nb_read_packets,width,height -of json "$STREAM_CHECK_OUTPUT" > "$CHECK_DIR/streams.json"
  python3 - "$CHECK_DIR/streams.json" <<'PY'
import json, sys
streams = json.load(open(sys.argv[1]))['streams']
for kind, codec in (('video', 'h264'), ('audio', 'aac')):
    if not any(s.get('codec_type') == kind and s.get('codec_name') == codec and int(s.get('nb_read_packets', 0)) > 0 for s in streams):
        raise SystemExit(f'Capture check failed: no {kind} packets produced')
print('Desktop capture check passed: H.264 video and AAC audio packets produced', flush=True)
PY
  ffmpeg -hide_banner -loglevel error -xerror -i "$STREAM_CHECK_OUTPUT" -t 2 -f null - >/dev/null
  echo 'Encoded capture sample decoded successfully'
  exit 0
fi

if [[ "${1:-}" == "--capture-worker" ]]; then
  CAPTURE_LOG="${ROOM_DATA_DIR:-/data/room}/desktop-stream.log"
  mkdir -p "$(dirname "$CAPTURE_LOG")"
  printf '%s Starting desktop capture: canvas=%sx%s stream=%s@30 encoder=%s target=%skbps%s\n' \
    "$(date -Is)" "$WIDTH" "$HEIGHT" "$OUTPUT_SIZE" "$ENCODER" "$STREAM_BITRATE_KBPS" \
    "${VAAPI_QP:+ vaapi_qp=$VAAPI_QP}" >>"$CAPTURE_LOG"
  OUTPUT_ARGS=(pipe:1)
  DURATION_ARGS=()
  if [[ -n "${STREAM_CHECK_OUTPUT:-}" ]]; then
    OUTPUT_ARGS=(-y "$STREAM_CHECK_OUTPUT")
    DURATION_ARGS=(-t 2)
  fi
  set +e
  gst-launch-1.0 -q \
    ximagesrc display-name="${DISPLAY:-:99.0}" show-pointer=false use-damage=false \
    '!' "video/x-raw,width=${WIDTH},height=${HEIGHT},framerate=30/1" \
    '!' queue \
    '!' videoconvert \
    '!' video/x-raw,format=I420 \
    '!' fdsink fd=1 sync=false \
  | ffmpeg -hide_banner -loglevel warning -stats_period 5 -progress pipe:2 -fflags nobuffer -flags low_delay \
    "${HW_ARGS[@]}" \
    -f rawvideo -pixel_format yuv420p -video_size "${WIDTH}x${HEIGHT}" -framerate 30 -i pipe:0 \
    -f pulse -i "${STREAM_AUDIO_MONITOR:-audio_output.monitor}" \
    "${FILTER_ARGS[@]}" \
    -c:v "$ENCODER" "${ENCODER_ARGS[@]}" -level 3.1 \
    "${RATE_ARGS[@]}" -g 30 -keyint_min 30 -bf 0 \
    -c:a aac -b:a 96k -ar 48000 -ac 2 -flush_packets 1 -muxdelay 0 -muxpreload 0 \
    "${DURATION_ARGS[@]}" -f mpegts "${OUTPUT_ARGS[@]}" 2>>"$CAPTURE_LOG"
  PIPE_RESULTS=("${PIPESTATUS[@]}")
  # The finite startup sample closes the rawvideo pipe deliberately.
  if [[ -n "${STREAM_CHECK_OUTPUT:-}" ]]; then exit "${PIPE_RESULTS[1]}"; fi
  if (( PIPE_RESULTS[1] != 0 )); then exit "${PIPE_RESULTS[1]}"; fi
  exit "${PIPE_RESULTS[0]}"
fi

# Go2RTC may stop the exec wrapper while the shell pipeline is still alive.
# Isolate capture in its own process group so every child is reaped on disconnect.
setsid "$0" --capture-worker &
CAPTURE_SESSION_PID=$!
cleanup_capture() {
  trap - EXIT
  kill -TERM -- "-$CAPTURE_SESSION_PID" 2>/dev/null || true
  wait "$CAPTURE_SESSION_PID" 2>/dev/null || true
}
trap cleanup_capture EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
wait "$CAPTURE_SESSION_PID"
