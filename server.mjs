import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleSmbBrowser } from './smb-browser.mjs';
import { handleSmbCredentialRequest, smbShareForPlayback, smbPlaybackFile } from './smb-auth.mjs';
import { handleSmbMediaRequest } from './smb-stream.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ROOM_DATA_DIR || path.join(ROOT, 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const WALLPAPER_DIR = path.join(DATA_DIR, 'wallpapers');
const BRANDING_DIR = path.join(DATA_DIR, 'branding');
const CHAT_NOTIFICATION_DIR = path.join(DATA_DIR, 'chat-notifications');
const NEKO_CONFIG_FILE = path.join(DATA_DIR, 'neko.json');
const STATE_FILE = path.join(DATA_DIR, 'room.json');
const CHAT_LOG_FILE = path.join(DATA_DIR, 'chat-history.jsonl');
const VIDEO_HISTORY_DIR = path.join(DATA_DIR, 'video-history');
const USER_VIDEO_HISTORY_DIR = path.join(VIDEO_HISTORY_DIR, 'users');
const ROOM_VIDEO_HISTORY_FILE = path.join(VIDEO_HISTORY_DIR, 'room.jsonl');
const STREAM_OUTPUT_RESOLUTION_FILE = path.join(DATA_DIR, 'stream-output-resolution');
const STREAM_BITRATE_FILE = path.join(DATA_DIR, 'stream-bitrate-kbps');
const PORT = Number(process.env.PORT || 8080);
const BRIDGE_URL = (process.env.MEDIABRIDGE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const NEKO_PROXY_URL = (process.env.NEKO_PROXY_URL || '').replace(/\/+$/, '');
const GO2RTC_URL = (process.env.GO2RTC_URL || 'http://127.0.0.1:1984').replace(/\/+$/, '');
const ACTIVE_STREAMING_BACKEND = process.env.STREAMING_BACKEND === 'go2rtc' ? 'go2rtc' : 'neko';
const INITIAL_STREAMING_BACKEND = ACTIVE_STREAMING_BACKEND;
const DEFAULT_STREAM_BUFFER_SECONDS = 3;
const DEFAULT_STREAM_BITRATE_KBPS = 4000;
const JOIN_CODE = process.env.ROOM_JOIN_CODE || '';
const ADMIN_USERNAME = (process.env.ROOM_ADMIN_USERNAME || 'admin').toLowerCase();
const ADMIN_PASSWORD = process.env.ROOM_ADMIN_PASSWORD || '';
const DEFAULT_ROOM_NAME = process.env.ROOM_NAME || 'Baka-Inu';
const SESSION_COOKIE = 'mb_room_session';
const SESSION_TTL = 14 * 24 * 60 * 60 * 1000;
const ROOM_PRESENCE_GRACE_MS = 90_000;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_CHAT_LENGTH = 500;
const ROOM_QUALITIES = new Set(['480', '720', '1080', '1440', '2160']);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const WALLPAPER_MAX_BYTES = 8 * 1024 * 1024;
const BRANDING_MAX_BYTES = 2 * 1024 * 1024;
const CHAT_NOTIFICATION_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = new Map([
  ['image/png', { ext: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
  ['image/jpeg', { ext: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) }],
  ['image/webp', { ext: 'webp', signature: Buffer.from('RIFF') }],
]);

fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(WALLPAPER_DIR, { recursive: true });
fs.mkdirSync(BRANDING_DIR, { recursive: true });
fs.mkdirSync(CHAT_NOTIFICATION_DIR, { recursive: true });
fs.mkdirSync(USER_VIDEO_HISTORY_DIR, { recursive: true });

let state = loadState();
let persistedVideoSubmissions = initializeHistoryLogs();
state.videoSubmissions = persistedVideoSubmissions.slice(-2000);
syncNekoConfig();
let cachedStatus = null;
let statusError = 'MediaBridge status has not been read yet';
let desktopAvailable = false;
const roomMetadataCache = new Map();
const queueDurationCache = new Map();
const profileDurationPending = new Set();
let queueDurationBusy = false;
const roomMetadataFirstSeen = new Map();
const roomMetadataAttempts = new Map();
const roomMetadataQueued = new Set();
const roomMetadataQueue = [];
let roomMetadataBusy = false;
const lastSeen = new Map();
const userLatency = new Map();
const nekoConnections = new Map();
const authAttempts = new Map();
const chatPreviewCache = new Map();
const chatPreviewPending = new Map();
const chatPreviewAttempts = new Map();
const chatLinkCache = new Map();
const chatLinkPending = new Map();
const chatLinkJobs = [];
let chatLinkWorkers = 0;
const chatLinkAttempts = new Map();

function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const website = loaded.website && typeof loaded.website === 'object' ? loaded.website : {};
    const remoteAccess = normalizeRemoteAccess(loaded.remoteAccess);
    return {
      users: Array.isArray(loaded.users) ? loaded.users.map((item) => ({ ...item, role: item.isAdmin ? 'admin' : ['guest', 'user', 'moderator'].includes(item.role) ? item.role : item.isGuest ? 'guest' : 'user' })) : [],
      invites: Array.isArray(loaded.invites) ? loaded.invites.map((item) => ({ ...item, role: item.role === 'guest' ? 'guest' : 'user' })) : [],
      sessions: loaded.sessions && typeof loaded.sessions === 'object' ? loaded.sessions : {},
      messages: Array.isArray(loaded.messages) ? loaded.messages.slice(-100) : [],
      pinnedMessage: loaded.pinnedMessage && typeof loaded.pinnedMessage.id === 'string' && typeof loaded.pinnedMessage.message === 'string' && loaded.pinnedMessage.user?.id ? loaded.pinnedMessage : null,
      videoSubmissions: Array.isArray(loaded.videoSubmissions) ? loaded.videoSubmissions.slice(-2000) : [],
      controlMode: loaded.controlMode === 'controller' ? 'controller' : 'shared',
      controllerId: typeof loaded.controllerId === 'string' ? loaded.controllerId : null,
      wallpapers: Array.isArray(loaded.wallpapers) ? loaded.wallpapers.slice(-30) : [],
      selectedWallpaperId: typeof loaded.selectedWallpaperId === 'string' ? loaded.selectedWallpaperId : null,
      chatNotificationSound: typeof loaded.chatNotificationSound === 'string' && /^[a-f0-9]{24}\.mp3$/.test(loaded.chatNotificationSound) ? loaded.chatNotificationSound : null,
      branding: {
        logo: typeof loaded.branding?.logo === 'string' && /^[a-f0-9]{24}\.(png|jpg|webp)$/.test(loaded.branding.logo) ? loaded.branding.logo : null,
        favicon: typeof loaded.branding?.favicon === 'string' && /^[a-f0-9]{24}\.(png|jpg|webp)$/.test(loaded.branding.favicon) ? loaded.branding.favicon : null,
      },
      website: {
        serverName: cleanSettingText(website.serverName, DEFAULT_ROOM_NAME, 40),
        pageTitle: cleanSettingText(website.pageTitle, DEFAULT_ROOM_NAME, 60),
      },
      remoteAccess,
      streamingBackend: loaded.streamingBackend === 'go2rtc' || loaded.streamingBackend === 'neko' ? loaded.streamingBackend : INITIAL_STREAMING_BACKEND,
      streamBufferSeconds: Number.isInteger(loaded.streamBufferSeconds) && loaded.streamBufferSeconds >= 1 && loaded.streamBufferSeconds <= 10 ? loaded.streamBufferSeconds : DEFAULT_STREAM_BUFFER_SECONDS,
      streamOutputResolution: ['match', '854x480', '640x360'].includes(loaded.streamOutputResolution) ? loaded.streamOutputResolution : 'match',
      streamBitrateKbps: Number.isInteger(loaded.streamBitrateKbps) && loaded.streamBitrateKbps >= 500 && loaded.streamBitrateKbps <= 12000 ? loaded.streamBitrateKbps : DEFAULT_STREAM_BITRATE_KBPS,
    };
  } catch {
    return { users: [], invites: [], sessions: {}, messages: [], pinnedMessage: null, videoSubmissions: [], controlMode: 'shared', controllerId: null, wallpapers: [], selectedWallpaperId: null, chatNotificationSound: null, branding: { logo: null, favicon: null }, website: { serverName: DEFAULT_ROOM_NAME, pageTitle: DEFAULT_ROOM_NAME }, remoteAccess: normalizeRemoteAccess(null), streamingBackend: INITIAL_STREAMING_BACKEND, streamBufferSeconds: DEFAULT_STREAM_BUFFER_SECONDS, streamOutputResolution: 'match', streamBitrateKbps: DEFAULT_STREAM_BITRATE_KBPS };
  }
}

function readJsonLines(filename) {
  try {
    return fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
}

function appendJsonLine(filename, value) {
  fs.appendFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function initializeHistoryLogs() {
  if (!fs.existsSync(CHAT_LOG_FILE)) {
    let legacyMessages = state.messages;
    try {
      const legacy = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(legacy.messages)) legacyMessages = legacy.messages.slice(-300);
    } catch {}
    for (const message of legacyMessages) appendJsonLine(CHAT_LOG_FILE, { type: 'message', ...message });
  }
  if (!fs.existsSync(ROOM_VIDEO_HISTORY_FILE) && state.videoSubmissions.length) {
    for (const video of state.videoSubmissions) appendVideoHistory(video);
  }
  for (const filename of [CHAT_LOG_FILE, ROOM_VIDEO_HISTORY_FILE]) {
    const descriptor = fs.openSync(filename, 'a', 0o600);
    fs.closeSync(descriptor);
  }
  const history = readJsonLines(ROOM_VIDEO_HISTORY_FILE).filter((entry) => entry.type !== 'metadata' && entry.id && entry.user_id);
  const byUser = new Map();
  for (const video of history) {
    if (!byUser.has(video.user_id)) byUser.set(video.user_id, []);
    byUser.get(video.user_id).push(video);
  }
  for (const [userId, videos] of byUser) {
    const filename = path.join(USER_VIDEO_HISTORY_DIR, `${userId}.jsonl`);
    if (fs.existsSync(filename)) continue;
    fs.writeFileSync(filename, videos.map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
  }
  return history;
}

function appendVideoHistory(video) {
  appendJsonLine(ROOM_VIDEO_HISTORY_FILE, video);
  appendJsonLine(path.join(USER_VIDEO_HISTORY_DIR, `${video.user_id}.jsonl`), video);
}

function rewriteVideoHistoryFiles() {
  const byUser = new Map();
  const roomTemp = `${ROOM_VIDEO_HISTORY_FILE}.tmp`;
  fs.writeFileSync(roomTemp, persistedVideoSubmissions.map((item) => JSON.stringify(item)).join('\n') + (persistedVideoSubmissions.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(roomTemp, ROOM_VIDEO_HISTORY_FILE);
  for (const video of persistedVideoSubmissions) {
    if (!byUser.has(video.user_id)) byUser.set(video.user_id, []);
    byUser.get(video.user_id).push(video);
  }
  for (const [userId, videos] of byUser) {
    const filename = path.join(USER_VIDEO_HISTORY_DIR, `${userId}.jsonl`);
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, videos.map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(temporary, filename);
  }
}

fs.writeFileSync(STREAM_OUTPUT_RESOLUTION_FILE, state.streamOutputResolution || 'match');
fs.writeFileSync(STREAM_BITRATE_FILE, String(state.streamBitrateKbps || DEFAULT_STREAM_BITRATE_KBPS));

function cleanSettingText(value, fallback, maximum) {
  const text = typeof value === 'string' ? value.trim().slice(0, maximum) : '';
  return text || fallback;
}

function defaultPortRange() {
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(process.env.ROOM_INITIAL_WEBRTC_RANGE || process.env.NEKO_WEBRTC_EPR || '52000-52100');
  const start = match ? Number(match[1]) : 52000;
  const end = match ? Number(match[2]) : 52100;
  return start >= 52000 && end <= 52100 && start <= end ? { start, end } : { start: 52000, end: 52100 };
}

function normalizeRemoteAccess(value) {
  const defaults = defaultPortRange();
  const loaded = value && typeof value === 'object' ? value : {};
  const configured = loaded.configured === true;
  return {
    configured,
    publicHostname: configured ? cleanSettingText(loaded.publicHostname, '', 253) : '',
    trustProxy: configured && typeof loaded.trustProxy === 'boolean' ? loaded.trustProxy : process.env.TRUST_PROXY === 'true',
    rtcAddress: configured && typeof loaded.rtcAddress === 'string' ? loaded.rtcAddress.trim().slice(0, 253) : (process.env.ROOM_INITIAL_WEBRTC_ADDRESS || process.env.NEKO_WEBRTC_NAT1TO1 || '').trim().slice(0, 253),
    portStart: configured && Number.isInteger(loaded.portStart) && loaded.portStart >= 52000 && loaded.portStart <= 52100 ? loaded.portStart : defaults.start,
    portEnd: configured && Number.isInteger(loaded.portEnd) && loaded.portEnd >= 52000 && loaded.portEnd <= 52100 ? loaded.portEnd : defaults.end,
    iceUrls: configured && Array.isArray(loaded.iceUrls) ? loaded.iceUrls.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 10) : [],
    iceUsername: configured && typeof loaded.iceUsername === 'string' ? loaded.iceUsername.slice(0, 128) : '',
    iceCredential: configured && typeof loaded.iceCredential === 'string' ? loaded.iceCredential.slice(0, 256) : '',
  };
}

function trustProxyEnabled() { return Boolean(state.remoteAccess?.trustProxy); }
function roomName() { return state.website?.serverName || DEFAULT_ROOM_NAME; }

function syncNekoConfig() {
  const access = state.remoteAccess;
  const bitrateKbps = state.streamBitrateKbps || DEFAULT_STREAM_BITRATE_KBPS;
  const iceServers = access.iceUrls.map((url) => ({
    urls: [url],
    ...(access.iceUsername ? { username: access.iceUsername } : {}),
    ...(access.iceCredential ? { credential: access.iceCredential } : {}),
  }));
  const config = {
    server: { proxy: Boolean(access.trustProxy) },
    session: { merciful_reconnect: true, heartbeat_interval: 30 },
    capture: {
      video: {
        codec: 'vp8',
        ids: ['main'],
        pipelines: {
          main: {
            fps: 30,
            gst_encoder: 'vp8enc',
            gst_params: {
              'target-bitrate': bitrateKbps * 1000,
              'cpu-used': 4,
              'end-usage': 'cbr',
              threads: 4,
              deadline: 1,
              undershoot: 95,
              'buffer-size': bitrateKbps * 4,
              'buffer-initial-size': bitrateKbps * 2,
              'buffer-optimal-size': bitrateKbps * 3,
              'keyframe-max-dist': 25,
              'min-quantizer': 4,
              'max-quantizer': 20,
            },
          },
        },
      },
    },
    webrtc: { epr: `${access.portStart}-${access.portEnd}`, ...(access.rtcAddress ? { nat1to1: access.rtcAddress } : {}), ...(iceServers.length ? { iceservers: { frontend: iceServers, backend: iceServers } } : {}) },
  };
  const temporary = `${NEKO_CONFIG_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, NEKO_CONFIG_FILE);
}

function restartNeko() {
  return new Promise((resolve, reject) => {
    const child = spawn('supervisorctl', ['restart', 'neko'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output.trim() || `supervisorctl exited with status ${code}`)));
  });
}

function saveState() {
  const temporary = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

function newUserId() { return crypto.randomBytes(12).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('base64url'); }

function allowAuthAttempt(request) {
  const forwarded = trustProxyEnabled() ? String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const key = forwarded || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  current.count += 1;
  return current.count <= 12;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(user) {
  const role = user.isAdmin ? 'admin' : ['guest', 'user', 'moderator'].includes(user.role) ? user.role : user.isGuest ? 'guest' : 'user';
  return { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar || null, role, is_admin: role === 'admin', is_moderator: role === 'moderator', is_guest: role === 'guest', chat_enabled: user.chatEnabled !== false, quality: ROOM_QUALITIES.has(user.quality) ? user.quality : '720' };
}

function canModerate(user) { return Boolean(user?.isAdmin || user?.role === 'moderator'); }

function hardwareStatus() {
  const devices = [];
  try {
    for (const name of fs.readdirSync('/dev/dri').filter((name) => /^renderD\d+$/.test(name))) {
      const device = `/dev/dri/${name}`;
      const read = (file) => { try { return fs.readFileSync(`/sys/class/drm/${name}/device/${file}`, 'utf8').trim(); } catch { return null; } };
      const vendorId = read('vendor');
      let driver = null;
      try { driver = path.basename(fs.realpathSync(`/sys/class/drm/${name}/device/driver`)); } catch {}
      devices.push({ device, vendor: ({ '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'NVIDIA' })[vendorId] || vendorId || 'Unknown vendor', pci_id: read('device'), driver });
    }
  } catch {}
  try {
    for (const entry of fs.readdirSync('/proc/driver/nvidia/gpus')) {
      const info = fs.readFileSync(`/proc/driver/nvidia/gpus/${entry}/information`, 'utf8');
      devices.push({ device: entry, vendor: 'NVIDIA', model: info.match(/^Model:\s*(.+)$/m)?.[1] || null, driver: 'nvidia', accessible: null });
    }
  } catch {}
  if (!devices.some((device) => device.vendor === 'NVIDIA')) {
    try {
      for (const name of fs.readdirSync('/dev').filter((name) => /^nvidia\d+$/.test(name))) {
        devices.push({ device: `/dev/${name}`, vendor: 'NVIDIA', driver: 'nvidia' });
      }
    } catch {}
  }
  let startup = { status: 'checking', reason: 'Waiting for the streaming startup check' };
  try { startup = JSON.parse(fs.readFileSync('/tmp/baka-inu-hardware.json', 'utf8')); } catch {}
  const hasMedia = Boolean(cachedStatus?.current || cachedStatus?.playing || cachedStatus?.mirroring);
  return {
    backend: ACTIVE_STREAMING_BACKEND, cpu_model: os.cpus()[0]?.model || 'Unknown CPU', logical_cpus: os.cpus().length, architecture: os.arch(), devices: devices.map((device) => ({ ...device, accessible: startup.device_access?.[device.device] ?? null })), startup,
    decoding: { requested: process.env.MEDIABRIDGE_MPV_HWDEC || 'auto', active: hasMedia ? cachedStatus?.hardware_decoder || 'not reported' : 'idle', error: cachedStatus?.playback_error || null },
    stream_available: desktopAvailable,
    encoder: ACTIVE_STREAMING_BACKEND === 'neko' ? 'vp8enc (software)' : startup.encoder || 'checking',
    note: 'Devices listed here are visible inside this container. Decoder support depends on the codec of the current video.',
  };
}

function mentionedUserIds(message) {
  const text = String(message || '');
  return state.users.filter((candidate) => {
    const nickname = String(candidate.nickname || '').trim();
    if (!nickname) return false;
    const escaped = nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
  }).map((candidate) => candidate.id);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function currentUser(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = state.sessions[token];
  if (!session || session.expires <= Date.now()) {
    delete state.sessions[token];
    return null;
  }
  const user = state.users.find((item) => item.id === session.userId) || null;
  if (user) lastSeen.set(user.id, Date.now());
  return user;
}

function sessionFailureReason(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) return 'cookie_missing';
  const session = state.sessions[token];
  if (!session) return 'session_not_found';
  if (session.expires <= Date.now()) return 'session_expired';
  if (!state.users.some((item) => item.id === session.userId)) return 'user_not_found';
  return 'unknown';
}

function logSessionRejection(request, reason = sessionFailureReason(request)) {
  const path = new URL(request.url, 'http://room.local').pathname;
  console.warn(`authentication rejected path=${path} reason=${reason}`);
}

function secureCookie(request) {
  return Boolean(request.socket.encrypted || (trustProxyEnabled() && request.headers['x-forwarded-proto'] === 'https'));
}

function setSessionCookie(response, request, token) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(SESSION_TTL / 1000)}`];
  if (secureCookie(request)) parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(response, request) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secureCookie(request)) parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
}

function json(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  response.end(body);
}

function fail(response, status, message) { json(response, status, { error: message }); }

async function readJson(request, limit = MAX_JSON_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('request body must be valid JSON'), { status: 400 }); }
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const protocol = request.socket.encrypted || (trustProxyEnabled() && request.headers['x-forwarded-proto'] === 'https') ? 'https:' : 'http:';
    return new URL(origin).origin === `${protocol}//${request.headers.host}`;
  }
  catch { return false; }
}

function mediaPathPolicy(method, apiPath) {
  const verb = method.toUpperCase();
  const getPaths = new Set(['/status', '/preferences', '/platform', '/settings/port', '/settings/remote-origins', '/sunshine/pair/status']);
  const postPaths = new Set([
    '/play', '/play_preserve_queue', '/queue', '/queue_next', '/queue_batch', '/play_playlist', '/queue_playlist', '/queue_playlist_next',
    '/queue/remove', '/queue/play', '/queue/move', '/queue/promote', '/pause', '/resume', '/play_pause',
    '/rewind', '/forward', '/volume_up', '/volume_down', '/zoom_in', '/zoom_out', '/zoom_reset',
    '/seek', '/volume', '/previous', '/next', '/close', '/sleep', '/mouse', '/autoplay', '/resolve', '/resolve_async',
    '/settings/preferences', '/settings/port', '/settings/remote-origins', '/settings/cookies/check', '/settings/accounts/login',
    '/sunshine/pair', '/sunshine', '/autoplay/error/clear',
  ]);
  if (verb === 'GET' && getPaths.has(apiPath)) return { adminOnly: apiPath.startsWith('/settings/') || apiPath.startsWith('/sunshine/'), controlRequired: false };
  if (verb === 'POST' && postPaths.has(apiPath)) {
    const adminOnly = ['/sleep', '/volume', '/volume_up', '/volume_down', '/autoplay/error/clear'].includes(apiPath) || apiPath.startsWith('/settings/') || apiPath.startsWith('/sunshine/');
    return { adminOnly, controlRequired: !adminOnly };
  }
  return null;
}

function comparableMediaUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (['token', 'access_token', 'api_key', 'apikey', 'password', 'passwd', 'secret', 'signature', 'sig', 'auth', 'credential', 'session'].some((part) => normalized === part || normalized.includes(part))) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.href;
  } catch { return value; }
}

function originalSubmittedMediaUrl(value) {
  const comparable = comparableMediaUrl(value);
  for (let index = state.videoSubmissions.length - 1; index >= 0; index -= 1) {
    const submitted = state.videoSubmissions[index].url;
    if (comparableMediaUrl(submitted) === comparable) return submitted;
  }
  return value;
}

async function proxyMediaBridge(request, response, user, apiPath) {
  const policy = mediaPathPolicy(request.method, apiPath);
  if (!policy) return fail(response, 404, 'MediaBridge route is not available through the room');
  if (policy.adminOnly && !user.isAdmin) return fail(response, 403, 'only a room admin can use this MediaBridge feature');
  if (policy.controlRequired && !canControl(user)) return fail(response, 403, publicUser(user).is_guest ? 'guest accounts are watch-only' : 'take control of the room before sending playback commands');
  if (request.method === 'GET' && apiPath === '/status') {
    if (!cachedStatus) return fail(response, 503, statusError);
    return json(response, 200, { ...cachedStatus, autoplay_error: user.isAdmin ? cachedStatus.autoplay_error : null });
  }
  let body;
  if (request.method === 'POST') {
    try { body = await readJson(request); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    if (['/play', '/play_preserve_queue', '/queue', '/queue_next', '/play_playlist', '/queue_playlist', '/queue_playlist_next', '/queue/promote'].includes(apiPath)) body.queued_by_user_id = user.id;
    if (apiPath === '/play_preserve_queue' && typeof body?.url === 'string') {
      body.url = originalSubmittedMediaUrl(body.url);
    }
    if (['/play', '/play_preserve_queue', '/queue', '/queue_next'].includes(apiPath)) {
      const shareId = smbShareForPlayback(DATA_DIR, body?.url);
      if (shareId) body.smb_share_id = shareId; else delete body.smb_share_id;
    }
    if (apiPath === '/queue_batch') {
      if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 200 || !['next', 'last'].includes(body.mode)
          || body.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.url !== 'string')) return fail(response, 400, 'Select from 1 to 200 videos and choose next or last');
      for (const item of body.items) {
        item.queued_by_user_id = user.id;
        const shareId = smbShareForPlayback(DATA_DIR, item.url);
        if (shareId) item.smb_share_id = shareId; else delete item.smb_share_id;
      }
    }
  }
  const timeoutMs = ['/resolve', '/play_playlist', '/queue_playlist', '/queue_playlist_next'].includes(apiPath) ? 120_000 : 20_000;
  try {
    const upstream = await fetch(`${BRIDGE_URL}${apiPath}`, {
      method: request.method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await upstream.arrayBuffer();
    if (upstream.ok && apiPath === '/autoplay/error/clear' && cachedStatus) cachedStatus.autoplay_error = null;
    const submissionPaths = new Set(['/play', '/queue', '/queue_next', '/play_playlist', '/queue_playlist', '/queue_playlist_next']);
    const recordSingle = submissionPaths.has(apiPath) || (apiPath === '/play_preserve_queue' && typeof body?.url === 'string' && body.url.startsWith('smb://'));
    const submittedItems = apiPath === '/queue_batch' ? body?.items : recordSingle ? [body] : [];
    if (upstream.ok && request.method === 'POST' && submittedItems?.length) {
      for (const item of submittedItems) {
        if (typeof item?.url !== 'string' || !item.url.trim()) continue;
        state.videoSubmissions.push({ id: newUserId(), user_id: user.id, url: item.url.trim().slice(0, 4096),
          title: typeof item.title === 'string' ? item.title.slice(0, 300) : null,
          local: item.local === true, quality: ROOM_QUALITIES.has(String(item.quality)) ? String(item.quality) : null,
          submitted_at: new Date().toISOString() });
        const submission = state.videoSubmissions.at(-1);
        persistedVideoSubmissions.push(submission);
        appendVideoHistory(submission);
      }
      state.videoSubmissions = state.videoSubmissions.slice(-2000);
      saveState();
    }
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      'Content-Length': payload.byteLength,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(Buffer.from(payload));
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    fail(response, 502, timedOut ? 'MediaBridge did not respond in time' : 'MediaBridge is not reachable');
  }
}

async function refreshBridgeStatus() {
  try {
    const response = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`MediaBridge returned ${response.status}`);
    cachedStatus = await response.json();
    applyRoomMetadata(cachedStatus);
    scheduleRoomMetadata(cachedStatus);
    void resolveQueueDurations();
    statusError = '';
  } catch (error) {
    statusError = error.name === 'TimeoutError' ? 'MediaBridge status request timed out' : 'MediaBridge is not reachable';
  }
}

function metadataItems(status) {
  const currentUrl = status?.media_url || status?.current;
  const current = currentUrl ? [{ url: currentUrl, title: status?.title || null, thumbnail_url: status?.artwork_url || null }] : [];
  return [...(status?.queue_items || []), ...(status?.history_items || []), ...current];
}

function applyRoomMetadata(status) {
  for (const item of metadataItems(status)) {
    const submission = !item.autoplay_generated && !item.queued_by_user_id
      ? state.videoSubmissions.findLast((entry) => comparableMediaUrl(entry.url) === comparableMediaUrl(item.url)) : null;
    const submitter = state.users.find((user) => user.id === (item.queued_by_user_id || submission?.user_id));
    item.queued_by_name = submitter?.nickname || null;
    const duration = queueDurationCache.get(item.url)?.duration;
    if (Number.isFinite(duration)) item.duration_seconds = duration;
    const metadata = roomMetadataCache.get(item.url) || roomMetadataCache.get(comparableMediaUrl(item.url));
    if (metadata) Object.assign(item, metadata, { metadata_error: null });
    if (Number.isFinite(duration)) item.duration_seconds = duration;
  }
  const currentUrl = status?.media_url || status?.current;
  const currentSubmission = currentUrl && state.videoSubmissions.findLast((item) => comparableMediaUrl(item.url) === comparableMediaUrl(currentUrl));
  status.queued_by_name = state.users.find((user) => user.id === currentSubmission?.user_id)?.nickname || null;
  const currentMetadata = currentUrl && (roomMetadataCache.get(currentUrl) || roomMetadataCache.get(comparableMediaUrl(currentUrl)));
  if (currentMetadata) {
    if (!status.title && currentMetadata.title) status.title = currentMetadata.title;
    if (!status.artist && currentMetadata.uploader) status.artist = currentMetadata.uploader;
    if (!status.artwork_url && currentMetadata.thumbnail_url) status.artwork_url = currentMetadata.thumbnail_url;
  }
}

async function resolveQueueDurations() {
  if (queueDurationBusy) return;
  queueDurationBusy = true;
  try {
    while (true) {
      const items = cachedStatus?.queue_items || (cachedStatus?.queued || []).map((url) => ({ url }));
      let total = 0, next = null;
      for (const item of items) {
        const cached = queueDurationCache.get(item.url);
        const duration = cached?.duration ?? item.duration_seconds;
        if (Number.isFinite(duration) && duration >= 0) total += duration;
        else if (!next && (!cached || cached.retryAt <= Date.now())) next = item;
        if (total > 86400) break;
      }
      if (total > 86400 || !next) break;
      let duration = null;
      try {
        const link = chatMediaLink(next.url);
        const metadata = link ? await resolveChatLink(link, true) : next.url.toLowerCase().startsWith('smb://') ? {} : await runYtDlpMetadata(next.url);
        if (!metadata.is_live && Number.isFinite(metadata.duration_seconds) && metadata.duration_seconds >= 0) duration = metadata.duration_seconds;
      } catch (error) { console.warn(`[queue-duration] ${safeLogUrl(next.url)}: ${error.message}`); }
      queueDurationCache.set(next.url, { duration, retryAt: Date.now() + 60_000 });
      if (queueDurationCache.size > 2000) queueDurationCache.delete(queueDurationCache.keys().next().value);
      if (cachedStatus) applyRoomMetadata(cachedStatus);
    }
  } finally { queueDurationBusy = false; }
}

function scheduleRoomMetadata(status) {
  const now = Date.now();
  for (const item of metadataItems(status)) {
    if (!item?.url || item.url.toLowerCase().startsWith('smb://') || (item.title && item.thumbnail_url)) continue;
    const key = comparableMediaUrl(item.url);
    const firstSeen = roomMetadataFirstSeen.get(key) || now;
    roomMetadataFirstSeen.set(key, firstSeen);
    const attempts = roomMetadataAttempts.get(key) || { count: 0, nextAt: 0 };
    const shouldFallback = Boolean(item.metadata_error) || now - firstSeen >= 12_000;
    if (!shouldFallback || attempts.count >= 2 || now < attempts.nextAt || roomMetadataQueued.has(key)) continue;
    roomMetadataQueued.add(key);
    roomMetadataQueue.push(item.url);
  }
  void processRoomMetadataQueue();
}

function isYoutubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch { return false; }
}

async function youtubeOembedMetadata(mediaUrl) {
  if (!isYoutubeUrl(mediaUrl)) return null;
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', mediaUrl);
  endpoint.searchParams.set('format', 'json');
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Baka-Inu/1.0' } });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.title) return null;
    return { title: String(data.title), uploader: data.author_name ? String(data.author_name) : null,
      thumbnail_url: data.thumbnail_url ? String(data.thumbnail_url) : null };
  } catch { return null; }
}

async function youtubePageMetadata(mediaUrl) {
  try {
    const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Baka-Inu/1.0)' } });
    if (!response.ok) return {};
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2 * 1024 * 1024) break;
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    const html = Buffer.concat(chunks).toString('utf8');
    const match = /"videoDetails"\s*:\s*\{/.exec(html);
    if (!match) throw new Error(bytes > 2 * 1024 * 1024 ? 'watch page exceeded metadata size limit' : 'watch page has no videoDetails (possibly consent or sign-in required)');
    const start = match.index + match[0].length - 1;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < html.length; index += 1) {
      const char = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        const details = JSON.parse(html.slice(start, index + 1));
        if (details.videoId !== new URL(mediaUrl).searchParams.get('v')) return {};
        const duration = Number(details.lengthSeconds);
        return { title: details.title || null, uploader: details.author || null,
          thumbnail_url: details.thumbnail?.thumbnails?.at(-1)?.url || null,
          ...(Number.isFinite(duration) && duration > 0 ? { duration_seconds: duration } : {}) };
      }
    }
  } catch (error) { throw new Error(`YouTube watch-page lookup: ${error.message}`); }
  return {};
}

function runYtDlpMetadata(mediaUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', ['--dump-single-json', '--no-warnings', '--skip-download', '--ignore-no-formats-error', '--no-playlist', '--remote-components', 'ejs:github', mediaUrl], {
      stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    const chunks = [];
    let bytes = 0;
    let diagnostic = '';
    child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 5 * 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > 5 * 1024 * 1024) return reject(new Error(`yt-dlp metadata failed (exit=${code}): ${diagnostic.trim() || 'no diagnostics; process may have timed out'}`));
      try {
        const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];
        resolve({ title: info.title ? String(info.title) : null,
          uploader: info.uploader || info.channel ? String(info.uploader || info.channel) : null,
          thumbnail_url: info.thumbnail || thumbnails.at(-1)?.url || null,
          channel_avatar_url: info.channel_thumbnail || info.uploader_thumbnail || info.uploader_avatar || info.channel_avatar || null,
          duration_seconds: Number.isFinite(info.duration) ? info.duration : null,
          is_live: info.is_live === true,
          channel_banner_url: info.channel_banner || null });
      } catch (error) { reject(error); }
    });
  });
}

async function resolveRoomMetadata(mediaUrl) {
  const oembed = await youtubeOembedMetadata(mediaUrl);
  if (oembed?.title) return oembed;
  const extracted = await runYtDlpMetadata(mediaUrl);
  if (!extracted.title) throw new Error('metadata lookup returned no title');
  return extracted;
}

function chatMediaLink(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443') || value.length > 2048) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'twitch.tv' && /^\/(?:directory|downloads|settings|subscriptions|inventory|wallet|search|jobs|p|turbo)\/?$/i.test(url.pathname)) return null;
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
      const id = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1];
      if (!/^[\w-]{11}$/.test(id || '')) return null;
      return { url: `https://www.youtube.com/watch?v=${id}`, provider: 'YouTube' };
    }
    if (host === 'twitch.tv' && /^\/(?:[\w]{1,25}|videos\/\d+|[\w]{1,25}\/clip\/[\w-]+)\/?$/.test(url.pathname)) {
      return { url: `https://www.twitch.tv${url.pathname}`, provider: 'Twitch', channel: url.pathname.split('/')[1] };
    }
    if (host === 'clips.twitch.tv' && /^\/[\w-]+\/?$/.test(url.pathname)) return { url: `https://clips.twitch.tv${url.pathname}`, provider: 'Twitch' };
  } catch {}
  return null;
}

async function twitchPageMetadata(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(7000), redirect: 'error', headers: { 'User-Agent': 'Baka-Inu/1.0' } });
    if (!response.ok) return {};
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 1024 * 1024) break; chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel(); }
    const html = Buffer.concat(chunks).toString('utf8');
    const avatar = html.match(/"profileImageURL"\s*:\s*"(https:[^"]+)"/)?.[1];
    const metadata = { channel_avatar_url: avatar ? avatar.replaceAll('\\/', '/') : null };
    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
      const attributes = Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)].map((item) => [item[1].toLowerCase(), item[3]]));
      const property = (attributes.property || attributes.name || '').toLowerCase();
      const content = decodeHtmlAttribute(attributes.content || '');
      if (property === 'og:title' && content && content !== 'Twitch') metadata.title = content.replace(/\s*[-–|]\s*Twitch$/, '');
      if (property === 'og:image' && /^https:\/\//i.test(content)) {
        metadata.thumbnail_url = content;
        if (/profile_image|profile-image|user-default-pictures/i.test(content)) metadata.channel_avatar_url ||= content;
      }
    }
    return metadata;
  } catch { return {}; }
}

function resolveChatLink(link, details) {
  const key = `${details ? 'details' : 'title'}:${link.url}`;
  const cached = chatLinkCache.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.data);
  if (chatLinkPending.has(key)) return chatLinkPending.get(key);
  if (chatLinkJobs.length >= 24) return Promise.reject(new Error('preview queue is busy; try again shortly'));
  const job = new Promise((resolve, reject) => chatLinkJobs.push({ key, link, details, resolve, reject }));
  chatLinkPending.set(key, job);
  void processChatLinkJobs();
  return job;
}

async function processChatLinkJobs() {
  if (chatLinkWorkers >= 2) return;
  const job = chatLinkJobs.shift();
  if (!job) return;
  chatLinkWorkers += 1;
  try {
    let metadata = roomMetadataCache.get(job.link.url) || {};
    const knownItem = metadataItems(cachedStatus).find((item) => comparableMediaUrl(item.url) === comparableMediaUrl(job.link.url) && Number.isFinite(item.duration_seconds));
    if (knownItem) metadata = { ...metadata, duration_seconds: knownItem.duration_seconds };
    if (job.link.provider === 'YouTube' && !job.details) metadata = await youtubeOembedMetadata(job.link.url) || metadata;
    else if (job.link.provider === 'YouTube') {
      let page = {};
      try { if (!Number.isFinite(metadata.duration_seconds)) page = await youtubePageMetadata(job.link.url); }
      catch (error) { console.warn(`[chat-link-preview] ${job.link.url}: ${error.message}`); }
      metadata = { ...metadata, ...page };
      if (!Number.isFinite(metadata.duration_seconds)) {
        try { metadata = { ...metadata, ...await runYtDlpMetadata(job.link.url) }; }
        catch (error) { console.warn(`[chat-link-preview] ${job.link.url}: ${error.message}`); }
      }
      if (!metadata.title) metadata = { ...metadata, ...await youtubeOembedMetadata(job.link.url) };
    } else {
      const [extracted, page] = await Promise.allSettled([runYtDlpMetadata(job.link.url), job.link.provider === 'Twitch' ? twitchPageMetadata(job.link.url) : Promise.resolve({})]);
      if (extracted.status === 'fulfilled') metadata = { ...metadata, ...extracted.value };
      if (page.status === 'fulfilled') {
        if (page.value.channel_avatar_url) metadata.channel_avatar_url = page.value.channel_avatar_url;
        if (!metadata.title && page.value.title) metadata.title = page.value.title;
        if (!metadata.thumbnail_url && page.value.thumbnail_url) metadata.thumbnail_url = page.value.thumbnail_url;
      }
      if (!metadata.title && job.link.provider === 'YouTube') metadata = await youtubeOembedMetadata(job.link.url) || metadata;
    }
    const data = { ...metadata, provider: job.link.provider, url: job.link.url, title: metadata.title || (job.link.channel ? `Twitch · ${job.link.channel}` : null) };
    const incomplete = job.details && !metadata.is_live && !Number.isFinite(metadata.duration_seconds);
    if (incomplete) console.warn(`[chat-link-preview] ${job.link.url}: duration unavailable after metadata lookup`);
    chatLinkCache.set(job.key, { data, expires: Date.now() + (job.link.provider === 'Twitch' || !metadata.title || incomplete ? 60_000 : 3600_000) });
    if (chatLinkCache.size > 400) chatLinkCache.delete(chatLinkCache.keys().next().value);
    job.resolve(data);
  } catch (error) { job.reject(error); }
  finally { chatLinkPending.delete(job.key); chatLinkWorkers -= 1; void processChatLinkJobs(); }
}

async function processRoomMetadataQueue() {
  if (roomMetadataBusy) return;
  roomMetadataBusy = true;
  try {
    while (roomMetadataQueue.length) {
      const mediaUrl = roomMetadataQueue.shift();
      const comparable = comparableMediaUrl(mediaUrl);
      roomMetadataQueued.delete(comparable);
      const attempts = roomMetadataAttempts.get(comparable) || { count: 0, nextAt: 0 };
      const waitingInRoom = metadataItems(cachedStatus).some((item) => comparableMediaUrl(item.url) === comparable && (!item.title || !item.thumbnail_url));
      const waitingInProfiles = state.videoSubmissions.some((item) => comparableMediaUrl(item.url) === comparable && (!item.title || !item.thumbnail_url));
      if (attempts.count >= 2 || (!waitingInRoom && !waitingInProfiles)) continue;
      attempts.count += 1;
      attempts.nextAt = Date.now() + attempts.count * 60_000;
      roomMetadataAttempts.set(comparable, attempts);
      try {
        const originalUrl = originalSubmittedMediaUrl(mediaUrl);
        const metadata = await resolveRoomMetadata(originalUrl);
        roomMetadataCache.set(mediaUrl, metadata);
        roomMetadataCache.set(comparableMediaUrl(originalUrl), metadata);
        let savedProfileMetadata = false;
        for (const item of state.videoSubmissions) {
          if (comparableMediaUrl(item.url) !== comparableMediaUrl(originalUrl)) continue;
          if (!item.title && metadata.title) item.title = metadata.title;
          if (!item.uploader && metadata.uploader) item.uploader = metadata.uploader;
          if (!item.thumbnail_url && metadata.thumbnail_url) item.thumbnail_url = metadata.thumbnail_url;
          savedProfileMetadata = true;
        }
        if (savedProfileMetadata) {
          for (const item of persistedVideoSubmissions) {
            if (comparableMediaUrl(item.url) !== comparableMediaUrl(originalUrl)) continue;
            if (!item.title && metadata.title) item.title = metadata.title;
            if (!item.uploader && metadata.uploader) item.uploader = metadata.uploader;
            if (!item.thumbnail_url && metadata.thumbnail_url) item.thumbnail_url = metadata.thumbnail_url;
          }
          rewriteVideoHistoryFiles();
          saveState();
        }
        if (cachedStatus) applyRoomMetadata(cachedStatus);
      } catch (error) {
        console.warn(`Baka-Inu metadata fallback failed for ${safeLogUrl(mediaUrl)}: ${error.message}`);
      }
    }
  } finally { roomMetadataBusy = false; }
}

function safeLogUrl(value) {
  try { const url = new URL(value); url.username = ''; url.password = ''; return `${url.origin}${url.pathname}`; }
  catch { return 'media URL'; }
}

async function refreshDesktopStatus() {
  if (ACTIVE_STREAMING_BACKEND === 'go2rtc') {
    try {
      const target = new URL(GO2RTC_URL);
      target.pathname = '/api/streams';
      target.search = '';
      const response = await fetch(target, { signal: AbortSignal.timeout(1500) });
      desktopAvailable = response.ok;
    } catch { desktopAvailable = false; }
    return;
  }
  if (!NEKO_PROXY_URL) { desktopAvailable = false; return; }
  try {
    const target = new URL(NEKO_PROXY_URL);
    target.pathname = '/neko/health';
    target.search = '';
    const response = await fetch(target, { signal: AbortSignal.timeout(1500) });
    desktopAvailable = response.ok;
  } catch { desktopAvailable = false; }
}

function canControl(user) {
  if (user.isAdmin) return true;
  if (user.role === 'guest' || (!user.role && user.isGuest)) return false;
  return state.controlMode === 'shared' || state.controllerId === user.id;
}

function disconnectNekoUser(userId) {
  const connections = nekoConnections.get(userId);
  if (!connections) return;
  nekoConnections.delete(userId);
  for (const socket of connections) socket.destroy();
}

function disconnectAllNekoUsers() {
  for (const userId of nekoConnections.keys()) disconnectNekoUser(userId);
}

function forwardedProtocol(request) {
  return request.socket.encrypted || (trustProxyEnabled() && request.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http';
}

function nekoPasswordFor(user) {
  // Only users who currently have room control get Neko's host credential;
  // guests and users without the controller token remain viewers.
  return canControl(user) ? ADMIN_PASSWORD : JOIN_CODE;
}

function proxyNeko(request, response) {
  if (!NEKO_PROXY_URL) return fail(response, 503, 'the remote desktop service is not configured');
  const target = new URL(NEKO_PROXY_URL);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = { ...request.headers, host: target.host, 'x-forwarded-host': request.headers.host || '', 'x-forwarded-proto': forwardedProtocol(request) };
  delete headers.connection;
  delete headers.upgrade;
  const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: request.method, path: request.url, headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) fail(response, 502, 'the remote desktop service is not reachable'); else response.destroy(); });
  request.pipe(upstream);
}

let desktopInputTail = Promise.resolve();
function runDesktopCommand(args) {
  const task = desktopInputTail.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/xdotool', args, { stdio: 'ignore', env: process.env });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`desktop input failed (${code})`)));
  }));
  desktopInputTail = task;
  return task;
}

function proxyGo2rtc(request, response) {
  const target = new URL(GO2RTC_URL);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = { ...request.headers, host: target.host, 'x-forwarded-host': request.headers.host || '', 'x-forwarded-proto': forwardedProtocol(request) };
  delete headers['accept-encoding'];
  delete headers.connection;
  delete headers.upgrade;
  const upstreamPath = request.url.replace(/^\/stream(?=\/)/, '');
  const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: request.method, path: upstreamPath, headers }, (upstreamResponse) => {
    if (request.url.startsWith('/stream/video-rtc.js')) {
      const chunks = [];
      upstreamResponse.on('data', (chunk) => chunks.push(chunk));
      upstreamResponse.on('end', () => {
        const source = Buffer.concat(chunks).toString('utf8');
        const patched = source
          .replace('const start = end - 5;', `const start = end - ${state.streamBufferSeconds || DEFAULT_STREAM_BUFFER_SECONDS};`)
          .replace('this.ondata = data => {', 'this.ondata = data => { if (window.BakaInuStreamData) window.BakaInuStreamData(this.video, data.byteLength);');
        const body = Buffer.from(patched);
        const responseHeaders = { ...upstreamResponse.headers, 'content-length': body.length, 'cache-control': 'no-store' };
        delete responseHeaders['content-encoding'];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        response.end(body);
      });
      upstreamResponse.on('error', () => { if (!response.headersSent) fail(response, 502, 'could not read the go2rtc player'); else response.destroy(); });
      return;
    }
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) fail(response, 502, 'the remote desktop service is not reachable'); else response.destroy(); });
  request.pipe(upstream);
}

function requireUser(request, response) {
  const failureReason = sessionFailureReason(request);
  const user = currentUser(request);
  if (!user) {
    logSessionRejection(request, failureReason);
    fail(response, 401, 'sign in to use this room');
    return null;
  }
  return user;
}

function avatarFromDataUrl(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(AVATAR_MAX_BYTES * 1.4)) throw new Error('image must be PNG, JPEG, or WebP and no larger than 2 MB');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error('image must be PNG, JPEG, or WebP');
  const type = AVATAR_TYPES.get(match[1]);
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > AVATAR_MAX_BYTES) throw new Error('image must be no larger than 2 MB');
  if (!data.subarray(0, type.signature.length).equals(type.signature)) throw new Error('image contents do not match the declared type');
  if (match[1] === 'image/webp' && data.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error('invalid WebP image');
  return { data, ext: type.ext };
}

function imageFromDataUrl(value, maximumBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximumBytes * 1.4)) throw new Error(`image must be no larger than ${Math.floor(maximumBytes / (1024 * 1024))} MB`);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error('image must be PNG, JPEG, or WebP');
  const type = AVATAR_TYPES.get(match[1]);
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > maximumBytes) throw new Error(`image must be no larger than ${Math.floor(maximumBytes / (1024 * 1024))} MB`);
  if (!data.subarray(0, type.signature.length).equals(type.signature)) throw new Error('image contents do not match the declared type');
  if (match[1] === 'image/webp' && data.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error('invalid WebP image');
  return { data, ext: type.ext };
}

function mp3FromDataUrl(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(CHAT_NOTIFICATION_MAX_BYTES * 1.4)) throw new Error('MP3 must be no larger than 5 MB');
  const match = /^data:audio\/mpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) throw new Error('choose a valid MP3 audio file');
  const data = Buffer.from(match[1], 'base64');
  if (!data.length || data.length > CHAT_NOTIFICATION_MAX_BYTES) throw new Error('MP3 must be no larger than 5 MB');
  const hasId3 = data.subarray(0, 3).toString('ascii') === 'ID3';
  const hasMpegFrame = data.length > 1 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
  if (!hasId3 && !hasMpegFrame) throw new Error('file contents do not look like an MP3');
  return data;
}

function applySelectedWallpaper() {
  const item = state.wallpapers.find((wallpaper) => wallpaper.id === state.selectedWallpaperId);
  if (!item || !process.env.DISPLAY) return { applied: false, reason: 'desktop is not running yet' };
  const file = path.join(WALLPAPER_DIR, item.filename);
  if (!fs.existsSync(file)) return { applied: false, reason: 'wallpaper file is missing' };
  if (!fs.existsSync('/usr/bin/feh') && !fs.existsSync('/bin/feh')) return { applied: false, reason: 'wallpaper support is not installed in this container yet' };
  const child = spawn('feh', ['--no-fehbg', '--bg-fill', file], { stdio: 'ignore', env: process.env });
  child.once('error', () => {});
  return { applied: true };
}

function contentType(filename) {
  if (filename.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.svg')) return 'image/svg+xml';
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.jpg')) return 'image/jpeg';
  if (filename.endsWith('.webp')) return 'image/webp';
  return 'text/html; charset=utf-8';
}

function chatPreviewProvider(value) {
  try {
    const url = new URL(value);
    if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (['tenor.com', 'www.tenor.com'].includes(hostname) && /^\/view\/.+-\d{4,}\/?$/i.test(url.pathname)) return 'tenor';
    return null;
  } catch { return null; }
}

function decodeHtmlAttribute(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)));
}

function findChatPreviewMediaUrl(html, pageUrl, provider) {
  const allowedHosts = ['media.tenor.com', 'media1.tenor.com', 'c.tenor.com'];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)].map((item) => [item[1].toLowerCase(), item[3]]));
    const property = (attributes.property || attributes.name || '').toLowerCase();
    if (!/^(og:image(?::secure_url)?|twitter:image(?::src)?)$/.test(property)) continue;
    try {
      const media = new URL(decodeHtmlAttribute(attributes.content || ''), pageUrl);
      if (media.protocol === 'https:' && allowedHosts.includes(media.hostname.toLowerCase())) return media.href;
    } catch {}
  }
  return null;
}

async function resolveChatPreviewMedia(pageUrl) {
  const cached = chatPreviewCache.get(pageUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.mediaUrl;
  if (chatPreviewPending.has(pageUrl)) return chatPreviewPending.get(pageUrl);
  const pending = (async () => {
    let current = new URL(pageUrl);
    const provider = chatPreviewProvider(pageUrl);
    let html = '';
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (chatPreviewProvider(current.href) !== provider) throw new Error('unsupported GIF page URL');
      const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Baka-Inu/1.0', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('GIF page redirect has no destination');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) throw new Error(`GIF page could not be read (HTTP ${response.status}, ${response.headers.get('content-type') || 'unknown content type'})`);
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > 2 * 1024 * 1024) throw new Error('Tenor page is too large');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('Tenor page is too large');
        chunks.push(chunk);
      }
      html = Buffer.concat(chunks).toString('utf8');
      break;
    }
    const mediaUrl = findChatPreviewMediaUrl(html, current.href, provider);
    if (!mediaUrl) throw new Error('GIF page did not include a direct media URL');
    chatPreviewCache.set(pageUrl, { mediaUrl, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    if (chatPreviewCache.size > 500) chatPreviewCache.delete(chatPreviewCache.keys().next().value);
    return mediaUrl;
  })().catch((error) => {
    chatPreviewCache.set(pageUrl, { mediaUrl: null, expiresAt: Date.now() + 2 * 60 * 1000 });
    throw error;
  }).finally(() => chatPreviewPending.delete(pageUrl));
  chatPreviewPending.set(pageUrl, pending);
  return pending;
}

async function handleApi(request, response, url) {
  if (await handleSmbCredentialRequest({ request, response, url, dataDir: DATA_DIR, json })) return;
  if (await handleSmbMediaRequest({ request, response, url, resolve: (id, value) => smbPlaybackFile(DATA_DIR, id, value), json })) return;
  if (url.pathname === '/api/admin/hardware' && request.method === 'GET') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can inspect hardware diagnostics');
    return json(response, 200, hardwareStatus());
  }
  if (url.pathname === '/api/branding' && request.method === 'GET') {
    return json(response, 200, {
      logo_url: state.branding?.logo ? `/branding/${state.branding.logo}` : null,
      favicon_url: state.branding?.favicon ? `/branding/${state.branding.favicon}` : null,
      server_name: roomName(),
      page_title: state.website?.pageTitle || roomName(),
    });
  }

  if (url.pathname === '/api/admin/chat-notification-sound' && ['GET', 'POST', 'DELETE'].includes(request.method)) {
    const user = requireUser(request, response);
    if (!user) return;
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can manage the chat notification sound');
    if (request.method !== 'GET' && !sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    const soundUrl = state.chatNotificationSound ? `/chat-notification-sounds/${state.chatNotificationSound}` : null;
    if (request.method === 'GET') return json(response, 200, { sound_url: soundUrl });
    if (request.method === 'DELETE') {
      const oldFilename = state.chatNotificationSound;
      state.chatNotificationSound = null;
      saveState();
      if (oldFilename) { try { fs.unlinkSync(path.join(CHAT_NOTIFICATION_DIR, oldFilename)); } catch {} }
      return json(response, 200, { sound_url: null });
    }
    let body;
    try { body = await readJson(request, 8 * 1024 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    try {
      const data = mp3FromDataUrl(body.audio_data_url);
      const filename = `${newUserId()}.mp3`;
      fs.writeFileSync(path.join(CHAT_NOTIFICATION_DIR, filename), data, { mode: 0o600 });
      const oldFilename = state.chatNotificationSound;
      state.chatNotificationSound = filename;
      saveState();
      if (oldFilename) { try { fs.unlinkSync(path.join(CHAT_NOTIFICATION_DIR, oldFilename)); } catch {} }
      return json(response, 201, { sound_url: `/chat-notification-sounds/${filename}` });
    } catch (error) { return fail(response, 400, error.message); }
  }

  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    const user = currentUser(request);
    return json(response, 200, { authenticated: Boolean(user), user: user ? publicUser(user) : null, room_name: roomName() });
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (!allowAuthAttempt(request)) {
      console.warn('authentication rejected path=/api/auth/login reason=rate_limited');
      return fail(response, 429, 'too many sign-in attempts; try again later');
    }
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const username = String(body.username || '').trim().toLowerCase();
    const user = state.users.find((item) => item.username === username);
    if (!user || !safeEqual(await hashPassword(String(body.password || ''), user.passwordSalt), user.passwordHash)) {
      console.warn('authentication rejected path=/api/auth/login reason=invalid_credentials');
      return fail(response, 401, 'username or password is incorrect');
    }
    const token = newToken();
    state.sessions[token] = { userId: user.id, expires: Date.now() + SESSION_TTL };
    saveState();
    setSessionCookie(response, request, token);
    console.info('authentication accepted path=/api/auth/login');
    return json(response, 200, { user: publicUser(user), room_name: roomName() });
  }

  if (url.pathname === '/api/auth/register' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (!allowAuthAttempt(request)) return fail(response, 429, 'too many account creation attempts; try again later');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const suppliedCode = String(body.join_code || '').trim();
    const invite = state.invites.find((item) => safeEqual(suppliedCode, item.code));
    if (!invite) return fail(response, 403, 'invite code is not valid');
    const username = String(body.username || '').trim().toLowerCase();
    const nickname = String(body.nickname || '').trim();
    const password = String(body.password || '');
    if (!/^[a-z0-9_-]{3,24}$/.test(username)) return fail(response, 400, 'username must be 3–24 letters, numbers, underscores, or hyphens');
    if (nickname.length < 1 || nickname.length > 32) return fail(response, 400, 'nickname must be 1–32 characters');
    if (password.length < 10 || password.length > 256) return fail(response, 400, 'password must be 10–256 characters');
    if (state.users.some((item) => item.username === username)) return fail(response, 409, 'that username is already in use');
    if (invite) state.invites = state.invites.filter((item) => item.id !== invite.id);
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    const role = invite.role === 'guest' ? 'guest' : 'user';
    const user = { id: newUserId(), username, nickname, passwordSalt, passwordHash: await hashPassword(password, passwordSalt), isAdmin: false, role, avatar: null, quality: '720' };
    state.users.push(user);
    const token = newToken();
    state.sessions[token] = { userId: user.id, expires: Date.now() + SESSION_TTL };
    saveState();
    setSessionCookie(response, request, token);
    return json(response, 201, { user: publicUser(user), room_name: roomName() });
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) delete state.sessions[token];
    saveState();
    clearSessionCookie(response, request);
    return json(response, 200, { ok: true });
  }

  const user = requireUser(request, response);
  if (!user) return;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
  if (await handleSmbBrowser({ request, response, url, user, dataDir: DATA_DIR, readJson, json, fail })) return;

  if (url.pathname === '/api/chat/link-preview' && request.method === 'GET') {
    const link = chatMediaLink(url.searchParams.get('url') || '');
    if (!link) return fail(response, 400, 'only YouTube video and Twitch links can be resolved');
    const details = url.searchParams.get('details') === '1';
    const key = `${details ? 'details' : 'title'}:${link.url}`;
    if (!chatLinkPending.has(key) && !(chatLinkCache.get(key)?.expires > Date.now())) {
      const now = Date.now();
      let attempt = chatLinkAttempts.get(user.id);
      if (!attempt || attempt.resetAt <= now) { attempt = { count: 0, resetAt: now + 60_000 }; chatLinkAttempts.set(user.id, attempt); }
      if (attempt.count >= 30) return fail(response, 429, 'too many new link previews; try again shortly');
      attempt.count += 1;
    }
    try { return json(response, 200, await resolveChatLink(link, details)); }
    catch (error) { return fail(response, 503, error.message || 'could not resolve chat link'); }
  }

  if (url.pathname === '/api/chat/preview' && request.method === 'GET') {
    const sourceUrl = url.searchParams.get('url') || '';
    if (!chatPreviewProvider(sourceUrl)) return fail(response, 400, 'only Tenor GIF page links can be previewed');
    const attempt = chatPreviewAttempts.get(user.id);
    const now = Date.now();
    if (attempt && attempt.resetAt > now && attempt.count >= 30) return fail(response, 429, 'too many GIF previews; try again shortly');
    if (!attempt || attempt.resetAt <= now) chatPreviewAttempts.set(user.id, { count: 1, resetAt: now + 60_000 });
    else attempt.count += 1;
    try { return json(response, 200, { media_url: await resolveChatPreviewMedia(sourceUrl) }); }
    catch (error) {
      console.warn(`chat preview resolution failed provider=${chatPreviewProvider(sourceUrl)} error=${error.message || 'unknown error'}`);
      return fail(response, 502, error.message || 'could not resolve GIF');
    }
  }

  if (url.pathname === '/api/admin/website' && request.method === 'POST') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change website identity');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const serverName = String(body.server_name || '').trim();
    const pageTitle = String(body.page_title || '').trim();
    if (!serverName || serverName.length > 40) return fail(response, 400, 'server name must be 1–40 characters');
    if (!pageTitle || pageTitle.length > 60) return fail(response, 400, 'page title must be 1–60 characters');
    state.website = { serverName, pageTitle };
    saveState();
    return json(response, 200, { server_name: roomName(), page_title: state.website.pageTitle });
  }

  if (url.pathname === '/api/admin/logs' && request.method === 'GET') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can download server history files');
    const files = [];
    const addFile = (key, label, filename, href) => {
      if (!fs.existsSync(filename)) return;
      const stat = fs.statSync(filename);
      if (!stat.isFile()) return;
      files.push({ key, label, filename: path.basename(filename), size_bytes: stat.size, download_url: href });
    };
    addFile('chat', 'Full room chat', CHAT_LOG_FILE, '/api/admin/logs/chat');
    addFile('room-videos', 'Room video history', ROOM_VIDEO_HISTORY_FILE, '/api/admin/logs/videos/room');
    let userHistoryFiles = [];
    try { userHistoryFiles = fs.readdirSync(USER_VIDEO_HISTORY_DIR).filter((name) => /^[a-f0-9]{24}\.jsonl$/.test(name)); } catch {}
    for (const name of userHistoryFiles) {
      const id = name.slice(0, -6);
      const member = state.users.find((entry) => entry.id === id);
      addFile(`user-videos-${id}`, `${member?.nickname || member?.username || id} · video history`, path.join(USER_VIDEO_HISTORY_DIR, name), `/api/admin/logs/videos/users/${id}`);
    }
    return json(response, 200, { files });
  }

  const historyDownloadMatch = /^\/api\/admin\/logs\/(chat|videos\/room|videos\/users\/([a-f0-9]{24}))$/.exec(url.pathname);
  if (historyDownloadMatch && request.method === 'GET') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can download server history files');
    const filename = historyDownloadMatch[1] === 'chat' ? CHAT_LOG_FILE
      : historyDownloadMatch[1] === 'videos/room' ? ROOM_VIDEO_HISTORY_FILE
        : path.join(USER_VIDEO_HISTORY_DIR, `${historyDownloadMatch[2]}.jsonl`);
    let stat;
    try { stat = fs.statSync(filename); } catch { return fail(response, 404, 'history file was not found'); }
    if (!stat.isFile()) return fail(response, 404, 'history file was not found');
    response.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${path.basename(filename)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filename).pipe(response);
    return;
  }

  if (url.pathname === '/api/admin/streaming-backend' && ['GET', 'POST'].includes(request.method)) {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change the streaming backend');
    if (request.method === 'GET') return json(response, 200, { selected: state.streamingBackend, active: ACTIVE_STREAMING_BACKEND });
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    if (!['neko', 'go2rtc'].includes(body.backend)) return fail(response, 400, 'backend must be neko or go2rtc');
    state.streamingBackend = body.backend;
    saveState();
    return json(response, 200, { selected: state.streamingBackend, active: ACTIVE_STREAMING_BACKEND, restart_required: state.streamingBackend !== ACTIVE_STREAMING_BACKEND });
  }

  if (url.pathname === '/api/stream-buffer' && request.method === 'GET') {
    return json(response, 200, { seconds: state.streamBufferSeconds || DEFAULT_STREAM_BUFFER_SECONDS });
  }

  if (url.pathname === '/api/admin/stream-buffer' && request.method === 'POST') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change the shared stream buffer');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const seconds = Number(body.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10) return fail(response, 400, 'buffer must be a whole number from 1 to 10 seconds');
    state.streamBufferSeconds = seconds;
    saveState();
    return json(response, 200, { seconds, reload_required: true });
  }

  if (url.pathname === '/api/admin/stream-output-resolution' && ['GET', 'POST'].includes(request.method)) {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change the stream resolution');
    if (request.method === 'GET') return json(response, 200, { resolution: state.streamOutputResolution || 'match' });
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const resolution = String(body.resolution || '');
    if (!['match', '854x480', '640x360'].includes(resolution)) return fail(response, 400, 'resolution must be match, 854x480, or 640x360');
    state.streamOutputResolution = resolution;
    saveState();
    fs.writeFileSync(STREAM_OUTPUT_RESOLUTION_FILE, resolution);
    return json(response, 200, { resolution, reconnect_required: true });
  }

  if (url.pathname === '/api/admin/stream-bitrate' && ['GET', 'POST'].includes(request.method)) {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change the stream bitrate');
    if (request.method === 'GET') return json(response, 200, { bitrate_kbps: state.streamBitrateKbps || DEFAULT_STREAM_BITRATE_KBPS });
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const bitrateKbps = Number(body.bitrate_kbps);
    if (!Number.isInteger(bitrateKbps) || bitrateKbps < 500 || bitrateKbps > 12000 || bitrateKbps % 500 !== 0) return fail(response, 400, 'bitrate must be a 500 kbps step from 500 to 12000 kbps');
    state.streamBitrateKbps = bitrateKbps;
    saveState();
    fs.writeFileSync(STREAM_BITRATE_FILE, String(bitrateKbps));
    try {
      syncNekoConfig();
      if (ACTIVE_STREAMING_BACKEND === 'neko') await restartNeko();
    } catch (error) {
      return fail(response, 500, `bitrate was saved, but Neko could not be restarted: ${error.message}`);
    }
    return json(response, 200, { bitrate_kbps: bitrateKbps, reconnect_required: ACTIVE_STREAMING_BACKEND === 'go2rtc', applied: ACTIVE_STREAMING_BACKEND === 'neko' });
  }

  if (url.pathname === '/api/admin/remote-access' && ['GET', 'POST'].includes(request.method)) {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change remote access settings');
    if (request.method === 'GET') {
      return json(response, 200, { ...state.remoteAccess, iceUrls: state.remoteAccess.iceUrls.join('\n'), hasIceCredential: Boolean(state.remoteAccess.iceCredential) });
    }
    let body;
    try { body = await readJson(request, 32 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const hostname = String(body.public_hostname || '').trim();
    if (hostname && (hostname.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(hostname))) return fail(response, 400, 'enter a hostname without a scheme, path, or port');
    const rtcAddress = String(body.rtc_address || '').trim();
    if (rtcAddress && (rtcAddress.length > 253 || !/^[a-z0-9.:-]+$/i.test(rtcAddress))) return fail(response, 400, 'WebRTC address must be an IP address or hostname without a scheme or path');
    const range = /^(\d{5})\s*-\s*(\d{5})$/.exec(String(body.port_range || '').trim());
    if (!range) return fail(response, 400, 'WebRTC UDP range must use the format 52000-52100');
    const portStart = Number(range[1]), portEnd = Number(range[2]);
    if (portStart < 52000 || portEnd > 52100 || portStart > portEnd) return fail(response, 400, 'WebRTC UDP ports must stay within the published 52000-52100 range');
    const iceUrls = String(body.ice_urls || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (iceUrls.length > 10 || iceUrls.some((item) => item.length > 512 || !/^(stun|stuns|turn|turns):[^\s]+$/i.test(item))) return fail(response, 400, 'ICE server entries must be STUN/TURN URLs, one per line, up to 10 entries');
    const iceUsername = String(body.ice_username || '').trim() || state.remoteAccess.iceUsername;
    const iceCredential = String(body.ice_credential || '') || state.remoteAccess.iceCredential;
    if (iceUsername.length > 128 || iceCredential.length > 256) return fail(response, 400, 'ICE credentials are too long');
    if ((iceUsername && !iceCredential) || (!iceUsername && iceCredential)) return fail(response, 400, 'enter both ICE username and credential, or leave both blank');
    state.remoteAccess = { configured: true, publicHostname: hostname, trustProxy: Boolean(body.trust_proxy), rtcAddress, portStart, portEnd, iceUrls, iceUsername, iceCredential };
    saveState();
    try {
      syncNekoConfig();
      if (ACTIVE_STREAMING_BACKEND === 'neko') await restartNeko();
    } catch (error) {
      return fail(response, 500, `settings were saved, but Neko could not be restarted: ${error.message}`);
    }
    const { iceCredential: _secret, ...safeSettings } = state.remoteAccess;
    return json(response, 200, { ...safeSettings, iceUrls: iceUrls.join('\n'), hasIceCredential: Boolean(iceCredential), applied: ACTIVE_STREAMING_BACKEND === 'neko' });
  }

  if (url.pathname === '/api/desktop/input' && request.method === 'POST') {
    if (ACTIVE_STREAMING_BACKEND !== 'go2rtc') return fail(response, 409, 'desktop input API is available only with the go2rtc backend');
    if (!canControl(user)) return fail(response, 403, publicUser(user).is_guest ? 'guest accounts are watch-only' : 'take control of the room before sending desktop input');
    let body;
    try { body = await readJson(request, 8 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    try {
      if (body.type === 'pointer') {
        if (!['move', 'down', 'up', 'click'].includes(body.action) || !['left', 'right', 'middle'].includes(body.button || 'left')) return fail(response, 400, 'invalid pointer action');
        const xRatio = Number(body.x), yRatio = Number(body.y);
        if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return fail(response, 400, 'pointer coordinates must be finite');
        const match = /^(\d{3,4})x(\d{3,4})/.exec(process.env.DESKTOP_SCREEN || '1280x720');
        const width = Number(match?.[1] || 1280), height = Number(match?.[2] || 720);
        const x = Math.max(0, Math.min(width - 1, Math.round(xRatio * (width - 1))));
        const y = Math.max(0, Math.min(height - 1, Math.round(yRatio * (height - 1))));
        const button = body.button === 'right' ? '3' : body.button === 'middle' ? '2' : '1';
        if (body.action === 'move') await runDesktopCommand(['mousemove', '--sync', String(x), String(y)]);
        else if (body.action === 'click') {
          await runDesktopCommand(['mousemove', '--sync', String(x), String(y)]);
          await runDesktopCommand(['click', '--clearmodifiers', button]);
        } else await runDesktopCommand(['mousemove', '--sync', String(x), String(y), body.action === 'down' ? 'mousedown' : 'mouseup', button]);
      } else if (body.type === 'scroll') {
        if (!['up', 'down'].includes(body.direction)) return fail(response, 400, 'invalid scroll direction');
        await runDesktopCommand(['click', body.direction === 'up' ? '4' : '5']);
      } else if (body.type === 'key') {
        if (!['press', 'down', 'up'].includes(body.action)) return fail(response, 400, 'invalid key action');
        const key = String(body.key || '');
        if (!/^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Return|BackSpace|Tab|Escape|space|Up|Down|Left|Right|Delete|Home|End|Page_Up|Page_Down|Shift_L|Control_L|Alt_L|Super_L|exclam|at|numbersign|dollar|percent|asciicircum|ampersand|asterisk|parenleft|parenright|underscore|plus|equal|minus|bracketleft|bracketright|backslash|semicolon|apostrophe|comma|period|slash|grave|braceleft|braceright|colon|quotedbl|less|greater|question|bar|asciitilde)$/.test(key)) return fail(response, 400, 'unsupported key');
        await runDesktopCommand(body.action === 'press' ? ['key', key] : [`key${body.action}`, key]);
      } else if (body.type === 'text') {
        const text = String(body.text || '');
        if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return fail(response, 400, 'text input is invalid or too long');
        await runDesktopCommand(['type', '--clearmodifiers', '--delay', '0', '--', text]);
      } else return fail(response, 400, 'unknown desktop input type');
      return json(response, 200, { ok: true });
    } catch (error) { return fail(response, 503, error.message || 'desktop input is unavailable'); }
  }

  const brandingRoute = /^\/api\/branding\/(logo|favicon)$/.exec(url.pathname);
  if (brandingRoute && ['POST', 'DELETE'].includes(request.method)) {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change website branding');
    const kind = brandingRoute[1];
    if (request.method === 'DELETE') {
      const oldFilename = state.branding?.[kind];
      state.branding ||= { logo: null, favicon: null };
      state.branding[kind] = null;
      if (oldFilename) { try { fs.unlinkSync(path.join(BRANDING_DIR, oldFilename)); } catch {} }
      saveState();
      return json(response, 200, { logo_url: state.branding.logo ? `/branding/${state.branding.logo}` : null, favicon_url: state.branding.favicon ? `/branding/${state.branding.favicon}` : null });
    }
    let body;
    try { body = await readJson(request, 3 * 1024 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    try {
      const { data, ext } = imageFromDataUrl(body.image_data_url, BRANDING_MAX_BYTES);
      const filename = `${newUserId()}.${ext}`;
      fs.writeFileSync(path.join(BRANDING_DIR, filename), data, { mode: 0o600 });
      state.branding ||= { logo: null, favicon: null };
      const oldFilename = state.branding[kind];
      state.branding[kind] = filename;
      if (oldFilename) { try { fs.unlinkSync(path.join(BRANDING_DIR, oldFilename)); } catch {} }
      saveState();
      return json(response, 201, { logo_url: state.branding.logo ? `/branding/${state.branding.logo}` : null, favicon_url: state.branding.favicon ? `/branding/${state.branding.favicon}` : null });
    } catch (error) { return fail(response, 400, error.message); }
  }

  if (url.pathname === '/api/admin/invites') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can manage invites');
    if (request.method === 'GET') return json(response, 200, { invites: state.invites.map(({ id, createdAt, role }) => ({ id, role: role === 'guest' ? 'guest' : 'user', created_at: createdAt })) });
    if (request.method === 'POST') {
      let body = {};
      try { body = await readJson(request, 4096); } catch (error) { return fail(response, error.status || 400, error.message); }
      const role = body.role === 'guest' ? 'guest' : body.role === 'user' || !body.role ? 'user' : null;
      if (!role) return fail(response, 400, 'invite role must be guest or user');
      const invite = { id: newUserId(), code: crypto.randomBytes(9).toString('base64url').toUpperCase(), role, createdAt: new Date().toISOString() };
      state.invites.push(invite);
      saveState();
      return json(response, 201, { invite: { id: invite.id, code: invite.code, role, created_at: invite.createdAt } });
    }
  }
  const inviteDelete = url.pathname.match(/^\/api\/admin\/invites\/([a-f0-9]{24})$/);
  if (inviteDelete && request.method === 'DELETE') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can manage invites');
    const previous = state.invites.length;
    state.invites = state.invites.filter((item) => item.id !== inviteDelete[1]);
    if (previous === state.invites.length) return fail(response, 404, 'invite was not found');
    saveState();
    return json(response, 200, { ok: true });
  }

  if (url.pathname === '/api/admin/members' && request.method === 'GET') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can manage member roles');
    return json(response, 200, { users: state.users.map(publicUser) });
  }
  const memberRoleMatch = /^\/api\/admin\/members\/([a-f0-9]{24})\/role$/.exec(url.pathname);
  if (memberRoleMatch && request.method === 'PATCH') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can manage member roles');
    let body;
    try { body = await readJson(request, 4096); } catch (error) { return fail(response, error.status || 400, error.message); }
    if (!['guest', 'user', 'moderator'].includes(body.role)) return fail(response, 400, 'member role must be guest, user, or moderator');
    const target = state.users.find((item) => item.id === memberRoleMatch[1]);
    if (!target) return fail(response, 404, 'room member was not found');
    if (target.isAdmin || target.id === user.id) return fail(response, 403, 'administrator roles cannot be changed here');
    if (target.role !== body.role) disconnectNekoUser(target.id);
    target.role = body.role;
    target.isGuest = body.role === 'guest';
    if (body.role === 'guest' && state.controllerId === target.id) state.controllerId = null;
    saveState();
    return json(response, 200, { user: publicUser(target) });
  }

  const memberChatAccessMatch = /^\/api\/admin\/members\/([a-f0-9]{24})\/chat-access$/.exec(url.pathname);
  if (memberChatAccessMatch && request.method === 'PATCH') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (!canModerate(user)) return fail(response, 403, 'only an admin or moderator can manage chat access');
    let body;
    try { body = await readJson(request, 4096); } catch (error) { return fail(response, error.status || 400, error.message); }
    if (typeof body.enabled !== 'boolean') return fail(response, 400, 'enabled must be true or false');
    const target = state.users.find((item) => item.id === memberChatAccessMatch[1]);
    if (!target) return fail(response, 404, 'room member was not found');
    if (target.isAdmin || (target.role === 'moderator' && !user.isAdmin) || target.id === user.id) return fail(response, 403, 'this member chat access cannot be changed');
    target.chatEnabled = body.enabled;
    saveState();
    return json(response, 200, { user: publicUser(target) });
  }

  if (url.pathname === '/api/room' && request.method === 'GET') {
    const users = state.users.map((item) => {
      const online = Date.now() - (lastSeen.get(item.id) || 0) < ROOM_PRESENCE_GRACE_MS;
      const latency = userLatency.get(item.id);
      return { ...publicUser(item), online, latency_ms: online && latency && Date.now() - latency.measuredAt < ROOM_PRESENCE_GRACE_MS ? latency.ms : null };
    });
    return json(response, 200, {
      name: roomName(),
      page_title: state.website?.pageTitle || roomName(),
      control_mode: state.controlMode,
      controller_id: state.controllerId,
      can_control: canControl(user),
      users,
      online_count: users.filter((item) => item.online).length,
      desktop_available: desktopAvailable,
      streaming_backend: ACTIVE_STREAMING_BACKEND,
      selected_streaming_backend: state.streamingBackend,
      desktop_encoder: ACTIVE_STREAMING_BACKEND === 'go2rtc' ? (() => { try { return fs.readFileSync('/tmp/baka-inu-stream-encoder', 'utf8').trim(); } catch { return 'starting'; } })() : 'neko',
      chat_notification_sound_url: state.chatNotificationSound ? `/chat-notification-sounds/${state.chatNotificationSound}` : null,
      messages: state.messages.slice(-100),
      pinned_message: state.pinnedMessage,
      current_user: publicUser(user),
    });
  }

  if (url.pathname === '/api/presence/latency' && request.method === 'POST') {
    let body;
    try { body = await readJson(request, 1024); } catch (error) { return fail(response, error.status || 400, error.message); }
    const value = Number(body.latency_ms);
    if (!Number.isFinite(value) || value < 0 || value > 60000) return fail(response, 400, 'latency_ms must be between 0 and 60000');
    userLatency.set(user.id, { ms: Math.round(value), measuredAt: Date.now() });
    return json(response, 200, { ok: true });
  }

  if (url.pathname === '/api/wallpaper' && request.method === 'GET') {
    return json(response, 200, {
      selected_id: state.selectedWallpaperId,
      wallpapers: state.wallpapers.map(({ id, name, filename }) => ({ id, name, url: `/wallpapers/${filename}` })),
      desktop_ready: Boolean(process.env.DISPLAY && (fs.existsSync('/usr/bin/feh') || fs.existsSync('/bin/feh'))),
    });
  }

  if (url.pathname === '/api/wallpaper/upload' && request.method === 'POST') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can upload desktop backgrounds');
    let body;
    try { body = await readJson(request, 12 * 1024 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    if (state.wallpapers.length >= 30) return fail(response, 409, 'remove a saved background before uploading another');
    const displayName = String(body.name || 'Background').trim().slice(0, 80) || 'Background';
    try {
      const { data, ext } = imageFromDataUrl(body.image_data_url, WALLPAPER_MAX_BYTES);
      const id = newUserId();
      const filename = `${id}.${ext}`;
      fs.writeFileSync(path.join(WALLPAPER_DIR, filename), data, { mode: 0o600 });
      state.wallpapers.push({ id, name: displayName, filename });
      saveState();
      return json(response, 201, { wallpaper: { id, name: displayName, url: `/wallpapers/${filename}` }, selected_id: state.selectedWallpaperId });
    } catch (error) { return fail(response, 400, error.message); }
  }

  if (url.pathname === '/api/wallpaper/select' && request.method === 'POST') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change the desktop background');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    if (body.id !== null && !state.wallpapers.some((wallpaper) => wallpaper.id === body.id)) return fail(response, 404, 'saved background was not found');
    state.selectedWallpaperId = body.id || null;
    saveState();
    const apply = applySelectedWallpaper();
    return json(response, 200, { selected_id: state.selectedWallpaperId, ...apply });
  }

  const wallpaperDelete = /^\/api\/wallpaper\/([a-f0-9]{24})$/.exec(url.pathname);
  if (wallpaperDelete && request.method === 'DELETE') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can remove desktop backgrounds');
    const [removed] = state.wallpapers.filter((item) => item.id === wallpaperDelete[1]);
    if (!removed) return fail(response, 404, 'saved background was not found');
    state.wallpapers = state.wallpapers.filter((item) => item.id !== removed.id);
    if (state.selectedWallpaperId === removed.id) state.selectedWallpaperId = null;
    try { fs.unlinkSync(path.join(WALLPAPER_DIR, removed.filename)); } catch {}
    saveState();
    return json(response, 200, { ok: true, selected_id: state.selectedWallpaperId });
  }

  if (url.pathname === '/api/profile' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    let body;
    try { body = await readJson(request, 3 * 1024 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    if (body.quality !== undefined) {
      const quality = String(body.quality);
      if (!ROOM_QUALITIES.has(quality)) return fail(response, 400, 'quality must be 480, 720, 1080, 1440, or 2160');
      user.quality = quality;
    }
    if (body.nickname !== undefined) {
      const nickname = String(body.nickname).trim();
      if (!nickname || nickname.length > 32) return fail(response, 400, 'nickname must be 1–32 characters');
      user.nickname = nickname;
    }
    if (body.avatar_data_url !== undefined) {
      try {
        const { data, ext } = avatarFromDataUrl(body.avatar_data_url);
        const filename = `${user.id}.${ext}`;
        for (const oldExt of ['png', 'jpg', 'webp']) {
          const oldPath = path.join(AVATAR_DIR, `${user.id}.${oldExt}`);
          if (oldExt !== ext && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        fs.writeFileSync(path.join(AVATAR_DIR, filename), data, { mode: 0o600 });
        user.avatar = `/avatars/${filename}?v=${Date.now()}`;
      } catch (error) { return fail(response, 400, error.message); }
    }
    for (const message of state.messages) if (message.user?.id === user.id) message.user = publicUser(user);
    if (state.pinnedMessage?.user?.id === user.id) state.pinnedMessage.user = publicUser(user);
    saveState();
    return json(response, 200, { user: publicUser(user) });
  }

  if (url.pathname === '/api/profile/gif-bookmarks' && request.method === 'GET') {
    return json(response, 200, { bookmarks: Array.isArray(user.gifBookmarks) ? user.gifBookmarks.slice(0, 5) : [] });
  }

  if (url.pathname === '/api/profile/gif-bookmarks' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const value = typeof body.url === 'string' ? body.url.trim() : '';
    let parsed;
    try { parsed = new URL(value); } catch { return fail(response, 400, 'enter a valid image or video link'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || value.length > 2048) return fail(response, 400, 'enter a valid HTTP or HTTPS media link');
    user.gifBookmarks = Array.isArray(user.gifBookmarks) ? user.gifBookmarks.slice(0, 5) : [];
    if (user.gifBookmarks.some((item) => item.url === parsed.href)) return json(response, 200, { bookmarks: user.gifBookmarks });
    if (user.gifBookmarks.length >= 5) return fail(response, 409, 'you can save up to five bookmarks');
    user.gifBookmarks.push({ id: newUserId(), url: parsed.href, created_at: new Date().toISOString() });
    saveState();
    return json(response, 201, { bookmarks: user.gifBookmarks });
  }

  const gifBookmarkMatch = /^\/api\/profile\/gif-bookmarks\/([a-f0-9]{24})$/.exec(url.pathname);
  if (gifBookmarkMatch && request.method === 'DELETE') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    user.gifBookmarks = Array.isArray(user.gifBookmarks) ? user.gifBookmarks : [];
    const previousLength = user.gifBookmarks.length;
    user.gifBookmarks = user.gifBookmarks.filter((item) => item.id !== gifBookmarkMatch[1]);
    if (user.gifBookmarks.length === previousLength) return fail(response, 404, 'bookmark was not found');
    saveState();
    return json(response, 200, { bookmarks: user.gifBookmarks });
  }

  if (url.pathname === '/api/control/mode' && request.method === 'POST') {
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can change the control mode');
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    if (!['shared', 'controller'].includes(body.mode)) return fail(response, 400, 'mode must be shared or controller');
    state.controlMode = body.mode;
    if (state.controlMode === 'shared') state.controllerId = null;
    disconnectAllNekoUsers();
    saveState();
    return json(response, 200, { control_mode: state.controlMode, controller_id: state.controllerId });
  }

  if (url.pathname === '/api/control/claim' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (publicUser(user).is_guest) return fail(response, 403, 'guest accounts cannot take room control');
    if (state.controlMode !== 'controller') return fail(response, 409, 'controller handoff mode is not enabled');
    if (state.controllerId && state.controllerId !== user.id && !user.isAdmin) return fail(response, 409, 'the room already has a controller');
    const previousControllerId = state.controllerId;
    state.controllerId = user.id;
    if (previousControllerId && previousControllerId !== user.id) disconnectNekoUser(previousControllerId);
    disconnectNekoUser(user.id);
    saveState();
    return json(response, 200, { controller_id: state.controllerId });
  }

  if (url.pathname === '/api/control/handoff' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (state.controlMode !== 'controller') return fail(response, 409, 'controller handoff mode is not enabled');
    if (!user.isAdmin && state.controllerId !== user.id) return fail(response, 403, 'only the controller or an admin can hand off control');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const target = state.users.find((item) => item.id === body.user_id);
    if (!target) return fail(response, 404, 'room member was not found');
    if (publicUser(target).is_guest) return fail(response, 403, 'guest accounts cannot receive room control');
    const previousControllerId = state.controllerId;
    state.controllerId = target.id;
    if (previousControllerId) disconnectNekoUser(previousControllerId);
    disconnectNekoUser(target.id);
    saveState();
    return json(response, 200, { controller_id: state.controllerId });
  }

  if (url.pathname === '/api/chat' && request.method === 'GET') return json(response, 200, { messages: state.messages.slice(-100) });

  const memberProfileMatch = /^\/api\/members\/([a-f0-9]{24})\/profile$/.exec(url.pathname);
  if (memberProfileMatch && request.method === 'GET') {
    const target = state.users.find((item) => item.id === memberProfileMatch[1]);
    if (!target) return fail(response, 404, 'room member was not found');
    const allVideos = state.videoSubmissions
      .filter((item) => item.user_id === target.id)
      .slice(-100).reverse()
      .map((item) => {
        const metadata = roomMetadataCache.get(item.url) || roomMetadataCache.get(comparableMediaUrl(item.url)) || {};
        const attempts = roomMetadataAttempts.get(comparableMediaUrl(item.url)) || { count: 0 };
        const unresolved = !item.url.toLowerCase().startsWith('smb://') && (!(item.title || metadata.title) || !(item.thumbnail_url || metadata.thumbnail_url));
        return { ...item, local: item.local !== false, quality: item.quality || null,
          title: item.title || metadata.title || null, uploader: item.uploader || metadata.uploader || null,
          thumbnail_url: item.thumbnail_url || metadata.thumbnail_url || null,
          duration_seconds: item.duration_seconds ?? metadata.duration_seconds ?? queueDurationCache.get(item.url)?.duration ?? null,
          metadata_error: unresolved && attempts.count >= 2 ? 'Could not resolve video metadata' : null };
      });
    const pageCount = Math.min(10, Math.ceil(allVideos.length / 10));
    const requestedPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const page = pageCount ? Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1)) : 1;
    const videos = allVideos.slice((page - 1) * 10, page * 10);
    for (const video of videos) {
      const link = chatMediaLink(video.url);
      if (link && !Number.isFinite(video.duration_seconds) && !profileDurationPending.has(video.url)
          && !(queueDurationCache.get(video.url)?.retryAt > Date.now())) {
        profileDurationPending.add(video.url);
        void resolveChatLink(link, true).then((metadata) => {
          const duration = !metadata.is_live && Number.isFinite(metadata.duration_seconds) ? metadata.duration_seconds : null;
          queueDurationCache.set(video.url, { duration, retryAt: Date.now() + (duration === null ? 60_000 : 3600_000) });
          if (queueDurationCache.size > 2000) queueDurationCache.delete(queueDurationCache.keys().next().value);
        }).catch(() => {
          queueDurationCache.set(video.url, { duration: null, retryAt: Date.now() + 60_000 });
        }).finally(() => profileDurationPending.delete(video.url));
      }
      const metadataKey = comparableMediaUrl(video.url);
      if (!video.url.toLowerCase().startsWith('smb://') && (!video.title || !video.thumbnail_url) && !roomMetadataQueued.has(metadataKey)) {
        const attempts = roomMetadataAttempts.get(metadataKey) || { count: 0, nextAt: 0 };
        if (attempts.count < 2 && Date.now() >= attempts.nextAt) {
          roomMetadataQueued.add(metadataKey);
          roomMetadataQueue.push(video.url);
        }
      }
    }
    void processRoomMetadataQueue();
    const metadata_pending = videos.some((video) => {
      if (video.url.toLowerCase().startsWith('smb://')) return false;
      if (profileDurationPending.has(video.url)) return true;
      if (video.title && video.thumbnail_url) return false;
      return (roomMetadataAttempts.get(comparableMediaUrl(video.url))?.count || 0) < 2;
    });
    const metadata_errors = videos.some((video) => (!video.title || !video.thumbnail_url) && (roomMetadataAttempts.get(comparableMediaUrl(video.url))?.count || 0) >= 2);
    return json(response, 200, { user: publicUser(target), videos, page, page_count: pageCount, total: allVideos.length,
      metadata_pending, metadata_errors });
  }

  const memberKickMatch = /^\/api\/admin\/members\/([a-f0-9]{24})\/kick$/.exec(url.pathname);
  if (memberKickMatch && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (!canModerate(user)) return fail(response, 403, 'only an admin or moderator can remove a member from the room');
    const target = state.users.find((item) => item.id === memberKickMatch[1]);
    if (!target) return fail(response, 404, 'room member was not found');
    if (target.id === user.id) return fail(response, 400, 'you cannot kick your own account');
    if (target.isAdmin) return fail(response, 403, 'room admins cannot kick another admin');
    if (!user.isAdmin && target.role === 'moderator') return fail(response, 403, 'moderators cannot remove another moderator');
    for (const [token, session] of Object.entries(state.sessions)) {
      if (session.userId === target.id) delete state.sessions[token];
    }
    lastSeen.delete(target.id);
    if (state.controllerId === target.id) state.controllerId = null;
    disconnectNekoUser(target.id);
    saveState();
    return json(response, 200, { ok: true });
  }

  if (url.pathname === '/api/chat' && request.method === 'DELETE') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (!user.isAdmin) return fail(response, 403, 'only a room admin can clear chat messages');
    const removed = state.messages.length;
    appendJsonLine(CHAT_LOG_FILE, { type: 'clear', by_user_id: user.id, removed, created_at: new Date().toISOString() });
    state.messages = [];
    state.pinnedMessage = null;
    saveState();
    return json(response, 200, { ok: true, removed });
  }

  const chatMessageMatch = /^\/api\/chat\/([a-f0-9]{24})$/.exec(url.pathname);
  if (chatMessageMatch && request.method === 'DELETE') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    const index = state.messages.findIndex((item) => item.id === chatMessageMatch[1]);
    if (index < 0) return fail(response, 404, 'chat message not found');
    const message = state.messages[index];
    const ownsMessage = message.user?.id === user.id;
    if (!user.isAdmin && !ownsMessage && !canModerate(user)) return fail(response, 403, 'you can only delete your own messages');
    if (!user.isAdmin && canModerate(user) && !ownsMessage && message.user?.is_admin) return fail(response, 403, 'moderators cannot delete admin messages');
    appendJsonLine(CHAT_LOG_FILE, { type: 'delete', message_id: state.messages[index].id, by_user_id: user.id, created_at: new Date().toISOString() });
    if (state.pinnedMessage?.id === message.id) state.pinnedMessage = null;
    state.messages.splice(index, 1);
    saveState();
    return json(response, 200, { ok: true });
  }

  if (url.pathname === '/api/chat/pin' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (!canModerate(user)) return fail(response, 403, 'only an admin or moderator can pin chat messages');
    let body;
    try { body = await readJson(request, 4096); } catch (error) { return fail(response, error.status || 400, error.message); }
    const message = state.messages.find((item) => item.id === body.message_id);
    if (!message) return fail(response, 404, 'chat message not found');
    state.pinnedMessage = message;
    appendJsonLine(CHAT_LOG_FILE, { type: 'pin', message_id: message.id, by_user_id: user.id, created_at: new Date().toISOString() });
    saveState();
    return json(response, 200, { pinned_message: state.pinnedMessage });
  }

  if (url.pathname === '/api/chat/pin' && request.method === 'DELETE') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (!canModerate(user)) return fail(response, 403, 'only an admin or moderator can unpin chat messages');
    const oldMessage = state.pinnedMessage;
    state.pinnedMessage = null;
    if (oldMessage) appendJsonLine(CHAT_LOG_FILE, { type: 'unpin', message_id: oldMessage.id, by_user_id: user.id, created_at: new Date().toISOString() });
    saveState();
    return json(response, 200, { pinned_message: null });
  }

  if (url.pathname === '/api/chat' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(response, 403, 'cross-origin requests are not allowed');
    if (user.chatEnabled === false) return fail(response, 403, 'chat access has been disabled by an administrator');
    let body;
    try { body = await readJson(request, 16 * 1024); }
    catch (error) { return fail(response, error.status || 400, error.message); }
    const message = String(body.message || '').trim();
    if (!message || message.length > MAX_CHAT_LENGTH) return fail(response, 400, `message must be 1–${MAX_CHAT_LENGTH} characters`);
    const item = { id: newUserId(), user: publicUser(user), message, mentions: mentionedUserIds(message), created_at: new Date().toISOString() };
    appendJsonLine(CHAT_LOG_FILE, { type: 'message', ...item });
    state.messages.push(item);
    state.messages = state.messages.slice(-100);
    saveState();
    return json(response, 201, { message: item });
  }

  if (url.pathname.startsWith('/api/bridge/')) {
    const apiPath = url.pathname.slice('/api/bridge'.length);
    return proxyMediaBridge(request, response, user, apiPath);
  }

  return fail(response, 404, 'API route not found');
}

async function ensureAdmin() {
  if (!ADMIN_PASSWORD) return;
  const existing = state.users.find((user) => user.username === ADMIN_USERNAME);
  if (existing) {
    existing.isAdmin = true;
    existing.role = 'admin';
    return;
  }
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  state.users.push({
    id: newUserId(), username: ADMIN_USERNAME, nickname: 'Host', passwordSalt,
    passwordHash: await hashPassword(ADMIN_PASSWORD, passwordSalt), isAdmin: true, avatar: null, quality: '720',
  });
  saveState();
}

function serveStatic(request, response, pathname) {
  if (pathname === '/healthz') return json(response, 200, { ok: true });
  if (pathname.startsWith('/avatars/')) {
    const name = pathname.slice('/avatars/'.length);
    if (!/^[a-f0-9]{24}\.(png|jpg|webp)$/.test(name)) return fail(response, 404, 'not found');
    const file = path.join(AVATAR_DIR, name);
    if (!fs.existsSync(file)) return fail(response, 404, 'not found');
    const body = fs.readFileSync(file);
    response.writeHead(200, { 'Content-Type': contentType(name), 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return response.end(body);
  }
  if (pathname.startsWith('/wallpapers/')) {
    const name = pathname.slice('/wallpapers/'.length);
    if (!/^[a-f0-9]{24}\.(png|jpg|webp)$/.test(name)) return fail(response, 404, 'not found');
    const file = path.join(WALLPAPER_DIR, name);
    if (!fs.existsSync(file)) return fail(response, 404, 'not found');
    const body = fs.readFileSync(file);
    response.writeHead(200, { 'Content-Type': contentType(name), 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return response.end(body);
  }
  if (pathname.startsWith('/branding/')) {
    const name = pathname.slice('/branding/'.length);
    if (!/^[a-f0-9]{24}\.(png|jpg|webp)$/.test(name)) return fail(response, 404, 'not found');
    const file = path.join(BRANDING_DIR, name);
    if (!fs.existsSync(file)) return fail(response, 404, 'not found');
    const body = fs.readFileSync(file);
    response.writeHead(200, { 'Content-Type': contentType(name), 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return response.end(body);
  }
  if (pathname.startsWith('/chat-notification-sounds/')) {
    const name = pathname.slice('/chat-notification-sounds/'.length);
    if (!/^[a-f0-9]{24}\.mp3$/.test(name) || name !== state.chatNotificationSound) return fail(response, 404, 'not found');
    const file = path.join(CHAT_NOTIFICATION_DIR, name);
    if (!fs.existsSync(file)) return fail(response, 404, 'not found');
    const body = fs.readFileSync(file);
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': body.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return response.end(body);
  }
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return fail(response, 404, 'not found');
  const file = path.join(ROOT, 'public', name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(response, 404, 'not found');
  const body = fs.readFileSync(file);
  response.writeHead(200, { 'Content-Type': contentType(name), 'Content-Length': body.length, 'Cache-Control': ['index.html', 'app.js', 'style.css'].includes(name) ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/stream/')) {
      if (ACTIVE_STREAMING_BACKEND !== 'go2rtc') return fail(response, 404, 'go2rtc streaming is not active');
      if (url.pathname !== '/stream/video-rtc.js' && url.pathname !== '/stream/api/ws') return fail(response, 404, 'stream route not found');
      const failureReason = sessionFailureReason(request);
      if (!currentUser(request)) {
        logSessionRejection(request, failureReason);
        return fail(response, 401, 'sign in to use this room');
      }
      return proxyGo2rtc(request, response);
    }
    if (url.pathname === '/neko' || url.pathname.startsWith('/neko/')) {
      if (ACTIVE_STREAMING_BACKEND !== 'neko') return fail(response, 404, 'Neko streaming is not active');
      const failureReason = sessionFailureReason(request);
      if (!currentUser(request)) {
        logSessionRejection(request, failureReason);
        return fail(response, 401, 'sign in to use this room');
      }
      return proxyNeko(request, response);
    }
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return fail(response, 405, 'method not allowed');
      return await handleApi(request, response, url);
    }
    if (request.method !== 'GET') return fail(response, 405, 'method not allowed');
    return serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error('request failed:', error);
    if (!response.headersSent) fail(response, 500, 'internal server error');
    else response.destroy();
  }
});

server.on('upgrade', (request, socket, head) => {
  const upgradeUrl = new URL(request.url || '/', 'http://room.local');
  if (ACTIVE_STREAMING_BACKEND === 'go2rtc' && request.method === 'GET' && upgradeUrl.pathname === '/stream/api/ws' && upgradeUrl.searchParams.size === 1 && upgradeUrl.searchParams.get('src') === 'desktop') {
    const roomUser = currentUser(request);
    if (!roomUser) {
      logSessionRejection(request);
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    console.info(`go2rtc websocket upgrade received user=${roomUser.username}`);
    const target = new URL(GO2RTC_URL);
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: 'GET', path: `/api/ws${upgradeUrl.search}`, headers: { ...request.headers, host: target.host } });
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      console.info(`go2rtc websocket upstream accepted status=${upstreamResponse.statusCode || 101} user=${roomUser.username}`);
      socket.write(`HTTP/1.1 ${upstreamResponse.statusCode || 101} ${upstreamResponse.statusMessage || 'Switching Protocols'}\r\n`);
      for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2) socket.write(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}\r\n`);
      socket.write('\r\n');
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      upstreamSocket.on('error', (error) => {
        console.warn(`go2rtc websocket upstream closed with error user=${roomUser.username}: ${error.message}`);
        socket.destroy();
      });
      socket.on('error', (error) => {
        console.warn(`go2rtc websocket client closed with error user=${roomUser.username}: ${error.message}`);
        upstreamSocket.destroy();
      });
    });
    upstream.on('response', (upstreamResponse) => {
      console.warn(`go2rtc websocket upstream rejected status=${upstreamResponse.statusCode || 502} user=${roomUser.username}`);
      socket.end(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
      upstreamResponse.resume();
    });
    upstream.on('error', (error) => {
      console.error(`go2rtc websocket upstream error user=${roomUser.username}: ${error.message}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.end();
    return;
  }
  if (ACTIVE_STREAMING_BACKEND !== 'neko' || !NEKO_PROXY_URL || !(request.url === '/neko' || request.url?.startsWith('/neko/'))) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const roomUser = currentUser(request);
  if (!roomUser) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  let userConnections = nekoConnections.get(roomUser.id);
  if (!userConnections) { userConnections = new Set(); nekoConnections.set(roomUser.id, userConnections); }
  userConnections.add(socket);
  const removeConnection = () => {
    const connections = nekoConnections.get(roomUser.id);
    if (!connections) return;
    connections.delete(socket);
    if (!connections.size) nekoConnections.delete(roomUser.id);
  };
  socket.once('close', removeConnection);
  socket.once('error', removeConnection);
  const upstreamUrl = new URL(request.url, 'http://room.local');
  // Neko consumes its URL password in the browser, then sends it with its
  // authenticated WebSocket upgrade. Replace that placeholder server-side so
  // room credentials never need to be exposed in the page URL.
  if (upstreamUrl.searchParams.has('password')) {
    upstreamUrl.searchParams.set('password', nekoPasswordFor(roomUser));
    upstreamUrl.searchParams.set('username', roomUser.nickname || roomUser.username);
  }
  const target = new URL(NEKO_PROXY_URL);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = { ...request.headers, host: target.host, 'x-forwarded-host': request.headers.host || '', 'x-forwarded-proto': forwardedProtocol(request) };
  const upstream = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: 'GET', path: `${upstreamUrl.pathname}${upstreamUrl.search}`, headers });
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 ${upstreamResponse.statusCode || 101} ${upstreamResponse.statusMessage || 'Switching Protocols'}\r\n`);
    for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2) socket.write(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}\r\n`);
    socket.write('\r\n');
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
  });
  upstream.on('response', (upstreamResponse) => {
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
    upstreamResponse.resume();
  });
  upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  upstream.end();
});

await ensureAdmin();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Baka-Inu listening on :${PORT}`);
  void refreshBridgeStatus();
  setInterval(refreshBridgeStatus, 2000).unref();
  void refreshDesktopStatus();
  setInterval(refreshDesktopStatus, 5000).unref();
  if (state.selectedWallpaperId) setTimeout(applySelectedWallpaper, 1500).unref();
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
