ARG NEKO_BASE=ghcr.io/m1k1o/neko/base:3.1.6
ARG GO2RTC_IMAGE=alexxit/go2rtc:1.9.14

FROM ${GO2RTC_IMAGE} AS go2rtc-binary

FROM node:20-bookworm-slim AS neko-client-build
ARG NEKO_CLIENT_REF=v3.1.6
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${NEKO_CLIENT_REF} https://github.com/m1k1o/neko.git /src/neko
WORKDIR /src/neko/client
RUN npm install --no-audit --no-fund
COPY docker/patch-neko-autounmute.py /tmp/patch-neko-autounmute.py
RUN python3 /tmp/patch-neko-autounmute.py src/components/video.vue \
    && npm run build

FROM rust:1.90-bookworm AS mediabridge-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libgtk-3-dev libayatana-appindicator3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY mediabridge-src/ ./
RUN cargo build --locked --release

FROM ${NEKO_BASE} AS instance
USER root
COPY docker/install-runtime.sh /opt/instance/install-runtime.sh
RUN chmod +x /opt/instance/install-runtime.sh \
    && /opt/instance/install-runtime.sh \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg gstreamer1.0-tools x11-xserver-utils \
    util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=go2rtc-binary /usr/local/bin/go2rtc /usr/local/bin/go2rtc
COPY --from=neko-client-build /src/neko/client/dist/ /var/www/
COPY docker/patch-neko-resolutions.py /opt/instance/patch-neko-resolutions.py
RUN python3 /opt/instance/patch-neko-resolutions.py
COPY --from=mediabridge-build /src/target/release/mediabridge /usr/local/bin/mediabridge
RUN chmod -R a+rX /opt/librewolf-current/squashfs-root

COPY docker/supervisord/*.conf /etc/neko/supervisord/
COPY docker/go2rtc.yaml /opt/room/go2rtc.yaml
COPY docker/start-go2rtc.sh /usr/local/bin/start-go2rtc
COPY docker/start-go2rtc-as-neko.sh /usr/local/bin/start-go2rtc-as-neko
COPY docker/start-mediabridge-as-neko.sh /usr/local/bin/start-mediabridge-as-neko
COPY docker/start-desktop-stream.sh /usr/local/bin/start-desktop-stream
COPY docker/check-neko-stream.sh /usr/local/bin/check-neko-stream
RUN chmod 0755 /usr/local/bin/check-neko-stream
COPY docker/set-desktop-mode.sh /usr/local/bin/set-desktop-mode
COPY docker/start-instance.sh /usr/local/bin/start-instance
COPY server.mjs smb-browser.mjs smb-auth.mjs package.json /opt/room/
COPY public/ /opt/room/public/
RUN chmod 0755 /usr/local/bin/start-go2rtc /usr/local/bin/start-go2rtc-as-neko /usr/local/bin/start-mediabridge-as-neko /usr/local/bin/start-desktop-stream /usr/local/bin/set-desktop-mode /usr/local/bin/start-instance \
    && chown -R neko:neko /opt/room /data

ENV NODE_ENV=production \
    PORT=8081 \
    ROOM_DATA_DIR=/data/room \
    MEDIABRIDGE_URL=http://127.0.0.1:8765 \
    NEKO_PROXY_URL=http://127.0.0.1:8080 \
    GO2RTC_URL=http://127.0.0.1:1984 \
    STREAMING_BACKEND=neko \
    DESKTOP_SCREEN=1280x720 \
    STREAM_ENCODER=auto \
    NEKO_CONFIG=/data/room/neko.json \
    NEKO_SESSION_MERCIFUL_RECONNECT=true \
    NEKO_SESSION_HEARTBEAT_INTERVAL=30 \
    XDG_CONFIG_HOME=/data/mediabridge/config \
    XDG_DATA_HOME=/data/mediabridge/data \
    MEDIABRIDGE_LIBREWOLF_PROFILE=/data/mediabridge/profile \
    MEDIABRIDGE_LIBREWOLF_LAUNCHER=/usr/local/bin/mediabridge-librewolf \
    MEDIABRIDGE_MOONLIGHT=/opt/moonlight-current/squashfs-root/AppRun

VOLUME ["/data"]
EXPOSE 8081 52000-52100/udp
ENTRYPOINT ["/usr/local/bin/start-instance"]
