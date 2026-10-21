# Baka-Inu

Baka-Inu is a self-hosted, multi-user media room built around [MediaBridge](https://github.com/murasaki-dev/mediabridge). Friends can join a room to watch and control one shared MediaBridge instance through a browser. The site adds user profiles, invite codes, room chat, shared playback controls, queue and history, and remote desktop input.

The Docker image keeps the desktop lightweight: it starts an X.Org display with Openbox rather than a full desktop environment, and only launches fallback applications such as LibreWolf when needed. Administrators can choose a streaming backend:

- **go2rtc:** desktop video is delivered over the website's authenticated HTTP/WebSocket connection; no incoming media UDP ports are required.
- **Neko:** desktop video and input use WebRTC. This mode requires its configured UDP port range to be reachable by room participants.

MediaBridge's API stays private inside the container. The room website authenticates users and provides the controls through its interface.

## Quick start

1. Copy `.env.example` to `.env` and set strong values for `ROOM_JOIN_CODE` and `ROOM_ADMIN_PASSWORD`.
2. Build and start the container:

   ```sh
   docker compose up --build -d
   ```

3. Open `http://localhost:8080`, sign in as the configured admin, and create invite codes for other users.
4. Select **go2rtc** or **Neko** in **Advanced and host features**. The selected backend takes effect after the next container restart.

Room accounts, chat, settings, MediaBridge data, and uploaded images persist in the `room-data` Docker volume. Do not expose MediaBridge's API or go2rtc's internal listener directly to the internet. For remote use, put the website behind a trusted HTTPS reverse proxy or tunnel. go2rtc mode is designed to carry its stream through the website connection; Neko mode needs WebRTC UDP connectivity.

## Optional hardware acceleration

mpv decoding and desktop-stream encoding are separate. The image can use supported NVIDIA NVENC or VA-API devices when the host and Docker runtime expose them; otherwise playback or streaming falls back to software. See [`compose.nvidia.yaml`](compose.nvidia.yaml) and [`compose.vaapi.yaml`](compose.vaapi.yaml) for optional Docker GPU configurations.

Admins can inspect **Admin panel → Hardware and startup checks** for visible GPUs, driver/device access, the selected encoder, current mpv decoder, and startup diagnostics. go2rtc checks a short desktop capture using the same encoding settings and audio source as the live stream, verifies H.264/AAC packets, and decodes the sample. In automatic mode it tries software if hardware capture fails; explicitly requested hardware reports a failure instead. Neko checks desktop VP8 encoding and audio capture separately. Results also appear in container logs. These startup checks confirm the capture path starts; they do not benchmark sustained playback or test a viewer's network/browser. mpv decoding is checked through MediaBridge's status during actual playback.

## Projects used

- [MediaBridge](https://github.com/murasaki-dev/mediabridge) — media playback and its API.
- [Neko](https://github.com/m1k1o/neko) — optional WebRTC desktop streaming backend and embedded web client.
- [go2rtc](https://github.com/AlexxIT/go2rtc) — optional HTTP/WebSocket desktop streaming backend.
- [mpv](https://github.com/mpv-player/mpv) and [yt-dlp](https://github.com/yt-dlp/yt-dlp) — playback and media source handling through MediaBridge.
- [FFmpeg](https://ffmpeg.org/) and [GStreamer](https://gstreamer.freedesktop.org/) — desktop video capture and encoding.
- [X.Org](https://www.x.org/) and [Openbox](http://openbox.org/) — lightweight virtual display and window manager.
- [LibreWolf](https://librewolf.net/) — optional browser fallback for sign-in and websites that need a browser.
- [Moonlight](https://github.com/moonlight-stream/moonlight-qt) — optional remote desktop/game streaming client exposed by MediaBridge.
- [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/) — Baka-Inu room server and MediaBridge build runtime.
- [Deno](https://deno.com/) — runtime dependency installed for MediaBridge.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the service layout and data flow.

## SMB media browser

SMB playback uses a private, seekable HTTP relay backed by Samba's `python3-smbc`, so the packaged mpv does not need native SMB protocol support. No extra port is exposed. MediaBridge diagnostics are included in Docker logs and also saved in `/data/mediabridge/state/mediabridge/mediabridge.log`.

The admin's folder button in the top banner opens bookmarked SMB shares. Save a URL such as smb://192.168.1.50/Movies, then browse folders. Click a filename to play immediately while preserving the remaining queue, or use Play next / Play last. Checkboxes let you add up to 200 files together in selection order, including selections across folders and pages within the same share. “Select page” selects visible files. “Bookmark this folder” saves the current folder and retains its sign-in. Up to 20 share or subfolder bookmarks are stored on the persistent room data volume. Password-protected shares show a themed sign-in prompt. Credentials can be remembered encrypted on the server or kept for this server session; the bookmark Sign in button also lets the admin edit or clear them. No additional container ports are published.

