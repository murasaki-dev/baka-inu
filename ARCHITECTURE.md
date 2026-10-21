# Architecture

## Runtime layout

The deployment is a single image based on Neko's minimal `base` runtime. It contains both the Neko WebRTC server and the go2rtc HTTP/WebSocket stream path. An admin selects the backend in the website; the saved selection takes effect on the next container start, and startup enables only that backend in Supervisor. The shared desktop, MediaBridge, Openbox, and optional LibreWolf/Moonlight fallback binaries are common to either mode.

```text
Browser clients
   | HTTPS / room UI, auth, chat, MediaBridge controls
   v
Room Node service :8081 (published)
   |-- authenticated room endpoints --> MediaBridge :8765 (loopback only)
   |-- /neko path + WebSocket proxy --> Neko :8080 (loopback only, selected mode)
   `-- /stream WebSocket proxy -------> go2rtc :1984 (loopback only, selected mode)
                                        |-- Xorg + Openbox display :99
                                        `-- PulseAudio + GStreamer/FFmpeg
Browser clients <---- WebRTC UDP 52000-52100 ----> Neko (Neko mode)
Browser clients <---- authenticated WebSocket ----> go2rtc (go2rtc mode)
```

The room page loads the player and desktop input path for the selected backend. Neko supplies WebRTC input; go2rtc uses the authenticated browser player plus server-side X11 input. MediaBridge is a private service; the website makes its API capabilities available through authenticated, allowlisted room actions.

The room app maintains separate user profiles, chat, invitations and control roles. Neko uses internal shared credentials and implicit hosting so members can control the desktop after clicking it. Room control mode governs MediaBridge API actions; Neko input control remains shared among room participants.

## Resource approach

- No browser starts automatically. LibreWolf runs only through MediaBridge's fallback launcher.
- Openbox replaces a full desktop environment/window manager.
- The default virtual screen is 1280x720 at 30 fps.
- Neko captures/encodes the virtual display only when clients join the desktop stream.
- Room status polling is centralized server-side and shared among clients.
- Keep RAM/shared-memory and CPU needs measurable on the target host; tune screen size, fps and encoder after a real Docker/WebRTC run.

## Persistence

The single `/data` Docker volume stores room users/sessions, avatars, wallpapers, branding, site identity, WebRTC settings, and MediaBridge configuration/data/browser profile. The room keeps only the latest 100 chat messages in active state; the full append-only chat record (including moderation events) is stored in `chat-history.jsonl`. Video submissions are stored in `video-history/room.jsonl` and separately in `video-history/users/<user-id>.jsonl`. Each account's five GIF bookmarks are stored with its profile. Desktop stream state and the X display are ephemeral and restart with the container.

## Network and trust

The Compose file binds the website on host loopback by default and publishes UDP `52000-52100` for Neko mode. The admin panel can configure Neko's address, UDP range, and ICE servers. Do not publish either streaming backend's HTTP listener or MediaBridge's port. Neko sends media directly over WebRTC UDP; go2rtc streams through authenticated WebSockets and can pass through an HTTP reverse proxy. The admin-only trusted-proxy setting should only be enabled after direct origin access is blocked or restricted to a trusted proxy.

The MediaBridge API itself has no authentication. It binds to loopback and must not be published. The room server requires a signed session and checks its control policy before forwarding API operations.

## Build inputs and next engineering work

`mediabridge-src/` is a local snapshot of the MediaBridge Rust source and lockfile. The Dockerfile compiles this snapshot before copying the binary into the Neko runtime. Image build also fetches Deno and the optional LibreWolf and Moonlight AppImages.

The current Neko interface is embedded with a small local reverse proxy. Follow-on work should validate WebRTC networking and input permissions on a running Docker host, test the full MediaBridge dependency set against the upstream install script, then improve UI styling and link Neko login/permissions to room membership. Hardware encoding should be optional and enabled only when the target host supports it.
