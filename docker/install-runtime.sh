#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils squashfs-tools unzip \
  nodejs openbox mpv yt-dlp playerctl xdotool xdg-utils smbclient libavformat-extra \
  intel-media-va-driver mesa-va-drivers \
  python3 python3-smbc python3-secretstorage libnotify-bin feh \
  libgtk-3-0 libayatana-appindicator3-1 libnss3 libdbus-glib-1-2 \
  libxss1 libasound2 libpulse0 libdrm2 libgbm1 libx11-xcb1 libxtst6 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxrender1 libxcb1

# Debian's yt-dlp can lag behind the CLI options used by MediaBridge. Pin the
# standalone upstream release and verify it before replacing the distro copy.
YT_DLP_VERSION=2026.08.19
YT_DLP_SHA256=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
curl -fsSL --retry 3 "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux" -o /usr/local/bin/yt-dlp
printf '%s  %s\n' "$YT_DLP_SHA256" /usr/local/bin/yt-dlp | sha256sum -c -
chmod 0755 /usr/local/bin/yt-dlp
yt-dlp --help | grep -q -- '--remote-components'

curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

mkdir -p /opt/moonlight-current /opt/librewolf-current
python3 - <<'PY'
import json, re, urllib.request
url = 'https://api.github.com/repos/moonlight-stream/moonlight-qt/releases/latest'
req = urllib.request.Request(url, headers={'User-Agent': 'mediabridge-room-builder'})
data = json.load(urllib.request.urlopen(req))
matches = [a for a in data['assets'] if re.fullmatch(r'Moonlight-.+-x86_64\.AppImage', a['name'])]
if not matches:
    raise SystemExit('No x86_64 Moonlight AppImage found in latest release')
urllib.request.urlretrieve(matches[0]['browser_download_url'], '/tmp/moonlight.AppImage')
PY
chmod +x /tmp/moonlight.AppImage
/tmp/moonlight.AppImage --appimage-extract >/tmp/moonlight-extract.log
cp -a squashfs-root/. /opt/moonlight-current/
rm -rf squashfs-root /tmp/moonlight.AppImage /tmp/moonlight-extract.log

python3 - <<'PY'
import re, urllib.request
url = 'https://librewolf.net/installation/linux/'
req = urllib.request.Request(url, headers={'User-Agent': 'mediabridge-room-builder'})
page = urllib.request.urlopen(req).read().decode('utf-8', 'replace')
matches = re.findall(r'https://dl\.librewolf\.net/librewolf/[^\" ]+-linux-x86_64-appimage\.AppImage', page)
if not matches:
    raise SystemExit('Could not locate x86_64 LibreWolf AppImage URL')
urllib.request.urlretrieve(matches[0], '/tmp/librewolf.AppImage')
PY
chmod +x /tmp/librewolf.AppImage
(cd /opt/librewolf-current && /tmp/librewolf.AppImage --appimage-extract >/tmp/librewolf-extract.log)
rm -f /tmp/librewolf.AppImage /tmp/librewolf-extract.log
cat > /usr/local/bin/mediabridge-librewolf <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PROFILE="${MEDIABRIDGE_LIBREWOLF_PROFILE:-/data/mediabridge/profile}"
BROWSER_HOME="/data/mediabridge/librewolf-home"
mkdir -p "$PROFILE" "$BROWSER_HOME/.librewolf"
if [[ ! -f "$PROFILE/user.js" ]]; then
  cat > "$PROFILE/user.js" <<'PREFS'
user_pref("privacy.clearOnShutdown.cookies", false);
user_pref("privacy.clearOnShutdown.history", false);
user_pref("privacy.clearOnShutdown.sessions", false);
user_pref("privacy.clearOnShutdown_v2.cookiesAndStorage", false);
user_pref("privacy.sanitize.sanitizeOnShutdown", false);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("devtools.debugger.remote-enabled", true);
PREFS
fi
if [[ ! -f "$BROWSER_HOME/.librewolf/librewolf.overrides.cfg" ]]; then
  cat > "$BROWSER_HOME/.librewolf/librewolf.overrides.cfg" <<'PREFS'
pref("privacy.clearOnShutdown.cookies", false);
pref("privacy.clearOnShutdown_v2.cookiesAndStorage", false);
pref("privacy.sanitize.sanitizeOnShutdown", false);
pref("media.autoplay.default", 0);
pref("media.autoplay.blocking_policy", 0);
pref("devtools.debugger.remote-enabled", true);
PREFS
fi
export HOME="$BROWSER_HOME"
unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME
if [[ "${MEDIABRIDGE_LIBREWOLF_NO_BIDI:-0}" == 1 ]]; then
  exec /opt/librewolf-current/squashfs-root/AppRun --profile "$PROFILE" "$@"
fi
exec /opt/librewolf-current/squashfs-root/AppRun --profile "$PROFILE" --remote-debugging-port 9222 "$@"
EOF
chmod +x /usr/local/bin/mediabridge-librewolf

install -d -o neko -g neko /data /home/neko/.config /home/neko/.local/share
rm -rf /var/lib/apt/lists/* /tmp/*
