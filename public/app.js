import { initSmbBrowser } from '/smb-browser.js?v=0.1.2';

let go2rtcPlayerReady;
async function ensureGo2rtcPlayer() {
  if (!go2rtcPlayerReady) go2rtcPlayerReady = import('/stream/video-rtc.js').then(({ VideoRTC }) => {
    class BakaDesktopVideo extends VideoRTC {
      constructor() {
        super();
        // Keep the live MSE connection open when this browser tab is hidden.
        // go2rtc otherwise closes the stream on visibilitychange, which can
        // leave audio stopped until the user returns to the tab.
        this.background = true;
        this.visibilityCheck = false;
      }
      oninit() {
        super.oninit();
        this.video.controls = false;
        this.video.autoplay = true;
        this.video.playsInline = true;
        // go2rtc's MSE catch-up code can set playbackRate to the full buffered
        // delay (or 0.1x), which sounds severely sped up/slowed down after a
        // background-tab reconnect. Keep audio and video at normal speed;
        // the MSE viewer already seeks past data older than its live window.
        const rateDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
        if (rateDescriptor?.get && rateDescriptor?.set) {
          Object.defineProperty(this.video, 'playbackRate', {
            configurable: true,
            get() { return rateDescriptor.get.call(this); },
            set() { rateDescriptor.set.call(this, 1); },
          });
        }
        this.video.disablePictureInPicture = true;
        this.video.setAttribute('aria-label', 'Shared MediaBridge desktop');
        this.style.display = 'block';
        this.video.style.width = '100%';
        this.video.style.height = '100%';
        this.video.style.objectFit = 'contain';
        this.video.style.objectPosition = 'center center';
        this.video.style.background = '#080908';
        this.video.style.cursor = 'crosshair';
        this.video.addEventListener('timeupdate', () => renderStreamStats(this.video));
      }
      play() {
        if (!this.video) return;
        this.video.volume = localAudioVolume;
        this.video.muted = false;
        this.video.play().catch((error) => {
          // Preserve audio state on autoplay rejection/reconnect. Playback
          // controls and user gestures can retry without silently muting.
          if (error?.name !== 'NotAllowedError') console.warn('[Baka-Inu] Desktop stream play was rejected:', error);
        });
      }
      ondisconnect() {
        this.wsState = WebSocket.CLOSED;
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        this.pcState = WebSocket.CLOSED;
        if (this.pc) {
          this.pc.getSenders().forEach((sender) => sender.track?.stop());
          this.pc.close();
          this.pc = null;
        }
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.srcObject = null;
      }
    }
    if (!customElements.get('baka-desktop-video')) customElements.define('baka-desktop-video', BakaDesktopVideo);
  });
  return go2rtcPlayerReady;
}

const $ = (selector) => document.querySelector(selector);
const authView = $('#auth-view');
const roomView = $('#room-view');
const toast = $('#toast');
const ROOM_QUALITIES = new Set(['480', '720', '1080', '1440', '2160']);
const CHAT_NOTIFICATION_MODE_KEY = 'baka-inu-chat-notification-mode';
const CHAT_NOTIFICATION_SCOPE_KEY = 'baka-inu-chat-notification-scope';

let me = null;
let room = null;
let playback = null;
let isRegister = false;
let latestMessages = '';
let observedChatMessageIds = new Set();
let chatFeedInitialized = false;
let chatTitleFlashTimer = 0;
let chatTitleFlashVisible = false;
let chatNotificationAudio = null;
let mentionSuggestions = [];
let activeMentionSuggestion = 0;
let selectedAvatarData = null;
let selectedAvatarProcessing = false;
let toastTimer;
let seekTimer;
let historyPage = 0;
let renderedQueueSignature = '';
let renderedHistorySignature = '';
let playerHidden = false;
let hostVolumeTimer;
let lastLatencyReportAt = 0;
let activeMemberProfileId = null;
let activeMemberProfilePage = 1;
let memberProfileRequestId = 0;
let memberProfilePollTimer = 0;
let memberProfileRenderedSignature = '';
let hiddenPlaybackPreferences = { default_screen: null, cookies_browser: 'auto', cookies_profile: null };
let topNowPlayingSignature = '';
let gifBookmarks = [];
const LOCAL_AUDIO_VOLUME_KEY = 'baka-inu-local-audio-volume';
let localAudioVolume = 1;
let streamStatsVideo = null;
let streamStatsStartedAt = 0;
let streamStatsBytes = 0;
let streamStatsKbps = null;
try {
  const savedVolume = Number(localStorage.getItem(LOCAL_AUDIO_VOLUME_KEY));
  if (localStorage.getItem(LOCAL_AUDIO_VOLUME_KEY) !== null && Number.isFinite(savedVolume)) {
    localAudioVolume = Math.max(0, Math.min(1, savedVolume));
  }
} catch {}
const themeSelect = $('#theme-select');

$('#volume').value = String(Math.round(localAudioVolume * 100));
$('#volume-label').textContent = `${Math.round(localAudioVolume * 100)}%`;
$('#volume').style.setProperty('--fill', `${localAudioVolume * 100}%`);

window.BakaInuStreamData = (video, byteLength) => {
  const now = performance.now();
  if (streamStatsVideo !== video) {
    streamStatsVideo = video;
    streamStatsStartedAt = now;
    streamStatsBytes = 0;
    streamStatsKbps = null;
  }
  streamStatsBytes += Number(byteLength) || 0;
  const elapsed = now - streamStatsStartedAt;
  if (elapsed >= 1000) {
    streamStatsKbps = streamStatsBytes * 8 / elapsed;
    streamStatsBytes = 0;
    streamStatsStartedAt = now;
  }
  renderStreamStats(video);
};

function renderStreamStats(video = streamStatsVideo) {
  const output = $('#stream-stats');
  if (!output || !video) return;
  let delay = null;
  try {
    const ranges = video.buffered;
    if (ranges.length) delay = Math.max(0, ranges.end(ranges.length - 1) - video.currentTime);
  } catch {}
  output.textContent = `${streamStatsKbps === null ? '—' : `${Math.round(streamStatsKbps)} kbps`} · ${delay === null ? '—' : `${delay.toFixed(1)} s`}`;
  output.title = 'Incoming stream bitrate · this browser’s buffered video delay';
}

function applyTheme(theme, persist = true) {
  const available = ['pink', 'green', 'blue', 'red', 'yellow'];
  const selected = available.includes(theme) ? theme : 'pink';
  document.documentElement.dataset.theme = selected;
  if (themeSelect) themeSelect.value = selected;
  if (persist) {
    try { localStorage.setItem('mb_room_theme', selected); } catch {}
  }
}

try { applyTheme(localStorage.getItem('mb_room_theme') || 'pink', false); }
catch { applyTheme('pink', false); }
themeSelect?.addEventListener('change', () => applyTheme(themeSelect.value));

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw Object.assign(new Error(data?.error || `Request failed (${response.status})`), { code: data?.code, status: response.status });
  return data;
}

async function copyTextToClipboard(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {}
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('clipboard access is unavailable');
}

async function refreshBranding() {
  const branding = await request('/api/branding');
  $('#room-name').textContent = branding.server_name || 'Baka-Inu';
  $('#auth-server-name').textContent = branding.server_name || 'Baka-Inu';
  document.title = branding.page_title || branding.server_name || 'Baka-Inu';
  document.querySelectorAll('.brand-mark').forEach((mark) => {
    const image = mark.querySelector('.brand-logo');
    const letter = mark.querySelector('.brand-letter');
    if (branding.logo_url) {
      if (image.getAttribute('src') !== branding.logo_url) image.src = branding.logo_url;
      image.hidden = false;
      letter.hidden = true;
      mark.classList.add('has-custom-logo');
    } else {
      image.removeAttribute('src');
      image.hidden = true;
      letter.hidden = false;
      mark.classList.remove('has-custom-logo');
    }
  });
  const favicon = $('#site-favicon');
  if (branding.favicon_url) {
    if (favicon.getAttribute('href') !== branding.favicon_url) favicon.href = branding.favicon_url;
    const extension = branding.favicon_url.split('?')[0].split('.').pop();
    favicon.type = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  } else {
    favicon.href = '/favicon.svg';
    favicon.type = 'image/svg+xml';
  }
}

function post(url, body = {}) { return request(url, { method: 'POST', body: JSON.stringify(body) }); }

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function setAuthMode(register) {
  isRegister = register;
  $('#auth-title').textContent = register ? 'Join the room' : 'Welcome back';
  $('#auth-copy').textContent = register ? 'Create your account with an invite code.' : 'Sign in to join the room.';
  $('#nickname-field').hidden = !register;
  $('#join-code-field').hidden = !register;
  $('#auth-form [name=password]').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = register ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = register ? 'Already have an account? Sign in' : 'Create an account with an invite code';
  $('#auth-error').textContent = '';
}

$('#auth-toggle').addEventListener('click', () => setAuthMode(!isRegister));
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const body = Object.fromEntries(data.entries());
  $('#auth-error').textContent = '';
  try {
    await post(isRegister ? '/api/auth/register' : '/api/auth/login', body);
    await enterRoom();
  } catch (error) { $('#auth-error').textContent = error.message; }
});

async function enterRoom() {
  const info = await request('/api/auth/me');
  if (!info.authenticated) {
    setDesktopOpen(false);
    me = null;
    room = null;
    playback = null;
    roomView.hidden = true;
    authView.hidden = false;
    setAuthMode(false);
    return;
  }
  me = info.user;
  $('#playback-quality').value = ROOM_QUALITIES.has(me.quality) ? me.quality : '720';
  setRoomSidebarCollapsed(readSidebarPreference(me.id), false);
  let peopleCollapsed = false;
  try { peopleCollapsed = localStorage.getItem('baka-inu-people-collapsed') === 'true'; } catch {}
  setPeopleListCollapsed(peopleCollapsed, false);
  setPlayerHidden(readPlayerPreference(), false);
  roomView.hidden = false;
  authView.hidden = true;
  requestAnimationFrame(measureTopNowPlaying);
  $('#chat-messages').replaceChildren();
  latestMessages = '';
  observedChatMessageIds = new Set();
  chatFeedInitialized = false;
  updateMyProfile();
  $('#gif-bookmark-picker').hidden = true;
  $('#gif-bookmark-toggle').setAttribute('aria-expanded', 'false');
  await Promise.allSettled([refreshRoom(), refreshStatus(), loadGifBookmarks()]);
}

function readSidebarPreference(userId) {
  try { return localStorage.getItem(`mb_room_sidebar_${userId}`) === 'hidden'; }
  catch { return false; }
}

function setRoomSidebarCollapsed(collapsed, persist = true) {
  $('.workspace').classList.toggle('sidebar-hidden', collapsed);
  $('#room-sidebar').inert = collapsed;
  $('#room-sidebar').setAttribute('aria-hidden', String(collapsed));
  const button = $('#people-chat-toggle');
  button.classList.toggle('is-active', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-pressed', String(collapsed));
  button.setAttribute('aria-label', collapsed ? 'Show people and chat' : 'Hide people and chat');
  button.title = collapsed ? 'Show people and chat' : 'Hide people and chat';
  $('#people-chat-toggle-icon').textContent = collapsed ? '‹' : '›';
  $('#people-chat-toggle-label').textContent = collapsed ? 'Show people and chat' : 'Hide people and chat';
  if (persist && me) {
    try { localStorage.setItem(`mb_room_sidebar_${me.id}`, collapsed ? 'hidden' : 'shown'); } catch {}
  }
}

function readPlayerPreference() {
  try { return localStorage.getItem('mb_room_player') === 'hidden'; }
  catch { return false; }
}

function setPeopleListCollapsed(collapsed, persist = true) {
  $('.members-panel').classList.toggle('people-collapsed', collapsed);
  const toggle = $('#people-list-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Expand people list' : 'Collapse people list');
  toggle.title = collapsed ? 'Show people in the room' : 'Hide people list';
  $('#members-body').inert = collapsed;
  $('#members-body').setAttribute('aria-hidden', String(collapsed));
  if (persist) {
    try { localStorage.setItem('baka-inu-people-collapsed', String(collapsed)); } catch {}
  }
}

$('#people-list-toggle').addEventListener('click', () => {
  setPeopleListCollapsed(!$('.members-panel').classList.contains('people-collapsed'));
});

function setPlayerHidden(hidden, persist = true) {
  playerHidden = hidden;
  $('#player-stage').hidden = hidden;
  const button = $('#player-visibility-toggle');
  button.setAttribute('aria-pressed', String(hidden));
  button.setAttribute('aria-label', hidden ? 'Show video screen' : 'Hide video screen');
  $('#player-visibility-label').textContent = hidden ? 'Show video screen' : 'Hide video screen';
  $('#player-visibility-icon').textContent = hidden ? '▢' : '▣';
  if (persist) {
    try { localStorage.setItem('mb_room_player', hidden ? 'hidden' : 'shown'); } catch {}
  }
  if (hidden) setDesktopOpen(false);
  else if (room?.desktop_available) setDesktopOpen(true);
}

$('#player-visibility-toggle').addEventListener('click', () => {
  setPlayerHidden(!playerHidden);
});

function avatarNode(user, tiny = false) {
  const node = document.createElement('span');
  node.className = `avatar${tiny ? ' tiny' : ''}`;
  node.textContent = (user.nickname || '?').slice(0, 1).toUpperCase();
  if (user.avatar) {
    const image = document.createElement('img');
    image.src = user.avatar;
    image.alt = '';
    image.onerror = () => image.remove();
    node.replaceChildren(image);
  }
  return node;
}

function updateProfileAvatarPreview(user = me) {
  const preview = avatarNode(user);
  $('#profile-preview-avatar').replaceChildren(...preview.childNodes);
  if (user.avatar) { const img = document.createElement('img'); img.src = user.avatar; img.alt = ''; $('#profile-preview-avatar').replaceChildren(img); }
}

function updateMyProfile() {
  $('#my-avatar').replaceChildren();
  const av = avatarNode(me, true);
  $('#my-avatar').replaceChildren(...av.childNodes);
  $('#my-avatar').textContent = me.avatar ? '' : (me.nickname || '?').slice(0, 1).toUpperCase();
  if (me.avatar) {
    const img = document.createElement('img'); img.src = me.avatar; img.alt = ''; $('#my-avatar').replaceChildren(img);
  }
  $('#my-nickname').textContent = me.nickname;
}

function populateProfileDialog() {
  $('#profile-nickname').value = me.nickname;
  $('#chat-notification-mode').value = getChatNotificationMode();
  $('#chat-notification-scope').value = getChatNotificationScope();
  $('#profile-image').value = '';
  selectedAvatarData = null;
  updateProfileAvatarPreview();
  $('#profile-image-status').textContent = 'Choose an image to preview it before saving.';
}

function getChatNotificationMode() {
  try {
    const mode = localStorage.getItem(CHAT_NOTIFICATION_MODE_KEY);
    return ['off', 'flash', 'sound'].includes(mode) ? mode : 'off';
  } catch { return 'off'; }
}

function getChatNotificationScope() {
  try { return localStorage.getItem(CHAT_NOTIFICATION_SCOPE_KEY) === 'mentions' ? 'mentions' : 'all'; }
  catch { return 'all'; }
}

function mentionedUsersForMessage(message) {
  if (Array.isArray(message.mentions)) return message.mentions;
  const text = String(message.message || '');
  return (room?.users || []).filter((candidate) => {
    const nickname = String(candidate.nickname || '').trim();
    if (!nickname) return false;
    const escaped = nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
  }).map((candidate) => candidate.id);
}

function restoreChatNotificationTitle() {
  if (chatTitleFlashTimer) clearInterval(chatTitleFlashTimer);
  chatTitleFlashTimer = 0;
  chatTitleFlashVisible = false;
  document.title = room?.page_title || room?.name || 'Baka-Inu';
}

function flashForChatMessage(message) {
  if (document.hasFocus() && !document.hidden) return;
  restoreChatNotificationTitle();
  const baseTitle = room?.page_title || room?.name || 'Baka-Inu';
  const messageTitle = `New chat · ${message.user?.nickname || 'Room member'}`;
  chatTitleFlashVisible = true;
  document.title = messageTitle;
  chatTitleFlashTimer = setInterval(() => {
    if (document.hasFocus() && !document.hidden) return restoreChatNotificationTitle();
    chatTitleFlashVisible = !chatTitleFlashVisible;
    document.title = chatTitleFlashVisible ? messageTitle : baseTitle;
  }, 750);
}

function playChatNotificationSound() {
  const url = room?.chat_notification_sound_url;
  if (!url) return;
  if (!chatNotificationAudio || chatNotificationAudio.dataset.url !== url) {
    chatNotificationAudio = new Audio(url);
    chatNotificationAudio.preload = 'auto';
    chatNotificationAudio.dataset.url = url;
  }
  chatNotificationAudio.currentTime = 0;
  chatNotificationAudio.play().catch(() => {});
}

function processChatNotifications(messages) {
  if (!chatFeedInitialized) {
    observedChatMessageIds = new Set(messages.map((message) => message.id));
    chatFeedInitialized = true;
    return;
  }
  const incoming = messages.filter((message) => message?.id && !observedChatMessageIds.has(message.id));
  for (const message of incoming) observedChatMessageIds.add(message.id);
  if (observedChatMessageIds.size > 500) observedChatMessageIds = new Set([...observedChatMessageIds].slice(-300));
  const remoteMessages = incoming.filter((message) => message.user?.id !== me?.id);
  if (!remoteMessages.length || (document.hasFocus() && !document.hidden)) return;
  const notificationMessages = getChatNotificationScope() === 'mentions'
    ? remoteMessages.filter((message) => mentionedUsersForMessage(message).includes(me?.id))
    : remoteMessages;
  if (!notificationMessages.length) return;
  const mode = getChatNotificationMode();
  if (mode === 'flash') flashForChatMessage(notificationMessages.at(-1));
  else if (mode === 'sound') playChatNotificationSound();
}

function hideMentionPicker() {
  const picker = $('#mention-picker');
  picker.hidden = true;
  picker.replaceChildren();
  mentionSuggestions = [];
  activeMentionSuggestion = 0;
  $('#chat-input').removeAttribute('aria-activedescendant');
}

function updateMentionPicker() {
  const input = $('#chat-input');
  const picker = $('#mention-picker');
  const before = input.value.slice(0, input.selectionStart);
  const match = before.match(/(^|\s)@([^\s@]*)$/u);
  if (!match || me?.chat_enabled === false) { hideMentionPicker(); return; }
  const tokenStart = match.index + match[1].length;
  const query = match[2].toLocaleLowerCase();
  activeMentionSuggestion = 0;
  mentionSuggestions = (room?.users || [])
    .filter((candidate) => candidate.online && candidate.id !== me?.id && candidate.nickname?.toLocaleLowerCase().startsWith(query))
    .slice(0, 6);
  if (!mentionSuggestions.length) { hideMentionPicker(); return; }
  picker.replaceChildren();
  mentionSuggestions.forEach((candidate, index) => {
    const option = document.createElement('button');
    option.type = 'button'; option.id = `mention-option-${index}`; option.className = 'mention-option'; option.role = 'option';
    option.setAttribute('aria-selected', String(index === activeMentionSuggestion));
    const avatar = avatarNode(candidate, true); avatar.classList.add('mention-option-avatar');
    const label = document.createElement('span'); label.textContent = candidate.nickname;
    option.append(avatar, label);
    option.addEventListener('mousedown', (event) => event.preventDefault());
    option.addEventListener('click', () => {
      input.value = `${input.value.slice(0, tokenStart)}@${candidate.nickname} ${input.value.slice(input.selectionStart)}`;
      const cursor = tokenStart + candidate.nickname.length + 2;
      input.focus(); input.setSelectionRange(cursor, cursor); hideMentionPicker();
    });
    picker.append(option);
  });
  picker.hidden = false;
  input.setAttribute('aria-activedescendant', `mention-option-${activeMentionSuggestion}`);
}

$('#chat-input').addEventListener('input', updateMentionPicker);
$('#chat-input').addEventListener('click', updateMentionPicker);
$('#chat-input').addEventListener('keyup', (event) => {
  if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
  updateMentionPicker();
});
$('#chat-input').addEventListener('keydown', (event) => {
  if ($('#mention-picker').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); hideMentionPicker(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeMentionSuggestion = (activeMentionSuggestion + delta + mentionSuggestions.length) % mentionSuggestions.length;
    $('#mention-picker').querySelectorAll('.mention-option').forEach((option, index) => option.setAttribute('aria-selected', String(index === activeMentionSuggestion)));
    $('#chat-input').setAttribute('aria-activedescendant', `mention-option-${activeMentionSuggestion}`);
  } else if (event.key === 'Enter' && mentionSuggestions.length) {
    event.preventDefault(); $('#mention-picker').querySelectorAll('.mention-option')[activeMentionSuggestion]?.click();
  }
});

window.addEventListener('focus', restoreChatNotificationTitle);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.hasFocus()) restoreChatNotificationTitle();
});

function setConnection(ok, text) {
  const dot = $('#admin-bridge-dot');
  dot.classList.toggle('online', ok);
  dot.classList.toggle('error', !ok);
  $('#admin-bridge-status').textContent = text;
}

async function refreshRoom() {
  try {
    const startedAt = performance.now();
    room = await request('/api/room');
    if (room.current_user && me) { me = { ...me, ...room.current_user }; updateMyProfile(); }
    const latency = Math.round(performance.now() - startedAt);
    if (Date.now() - lastLatencyReportAt >= 12000) {
      lastLatencyReportAt = Date.now();
      post('/api/presence/latency', { latency_ms: latency }).catch(() => {});
    }
    renderRoom();
    void refreshWallpapers();
  } catch (error) {
    if (error.message.includes('sign in')) { await enterRoom(); return; }
    notify(error.message);
  }
}

function renderRoom() {
  if (!room) return;
  $('#room-name').textContent = room.name || 'Baka-Inu';
  if (!chatTitleFlashTimer) document.title = room.page_title || room.name || 'Baka-Inu';
  renderPinnedMessage(room.pinned_message);
  const desktopReady = Boolean(room.desktop_available);
  if (!playback) $('#decode-status').title = `Desktop stream encoder: ${room.desktop_encoder || 'starting'}. mpv decoding status appears when playback starts.`;
  $('#stage-content').setAttribute('aria-label', desktopReady ? 'Open shared desktop' : 'Desktop streaming is unavailable');
  $('#stage-content').title = desktopReady ? 'Click to open the shared desktop' : 'Desktop streaming is unavailable';
  $('#member-count').textContent = String(room.online_count || 0);
  const list = $('#members-list');
  list.replaceChildren();
  const onlineUsers = room.users.filter((user) => user.online);
  if (!onlineUsers.length) {
    const empty = document.createElement('p');
    empty.className = 'muted tiny-copy';
    empty.textContent = 'No one else is currently in the room.';
    list.append(empty);
  }
  for (const user of onlineUsers) {
    const item = document.createElement('div'); item.className = 'member member-open-profile'; item.tabIndex = 0; item.setAttribute('role', 'button'); item.setAttribute('aria-label', `View ${user.nickname}'s profile`);
    item.addEventListener('click', () => openMemberProfile(user.id));
    item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMemberProfile(user.id); } });
    item.append(avatarNode(user, true));
    const meta = document.createElement('div'); meta.className = 'member-info';
    const name = document.createElement('span'); name.className = 'member-name'; name.textContent = user.nickname;
    const label = document.createElement('span'); label.className = 'member-meta';
    label.textContent = user.id === me.id ? (user.is_guest ? 'YOU · GUEST' : 'YOU') : user.is_guest ? 'GUEST' : 'IN THE ROOM';
    meta.append(name, label); item.append(meta);
    const signal = document.createElement('span');
    const latency = Number.isFinite(user.latency_ms) ? user.latency_ms : null;
    const signalLevel = latency === null ? 0 : latency < 100 ? 4 : latency < 200 ? 3 : latency < 350 ? 2 : 1;
    const signalQuality = latency === null ? 'unknown' : signalLevel === 4 ? 'excellent' : signalLevel === 3 ? 'good' : signalLevel === 2 ? 'fair' : 'poor';
    signal.className = `member-signal ${signalQuality}`;
    signal.setAttribute('role', 'img');
    signal.setAttribute('aria-label', latency === null ? 'Connection latency is being measured' : `${signalQuality} connection, ${latency} milliseconds round trip`);
    signal.title = latency === null ? 'Measuring this browser’s connection to the room server' : `${signalQuality[0].toUpperCase()}${signalQuality.slice(1)} connection · ${latency} ms round trip to the room server`;
    for (let bar = 1; bar <= 4; bar += 1) {
      const mark = document.createElement('i');
      mark.className = bar <= signalLevel ? 'active' : '';
      signal.append(mark);
    }
    const latencyValue = document.createElement('span');
    latencyValue.className = 'member-signal-latency';
    latencyValue.textContent = latency === null ? '—' : `${latency} ms`;
    signal.append(latencyValue);
    item.append(signal);
    if (user.is_admin) { const badge = document.createElement('span'); badge.className = 'member-badge'; badge.textContent = 'HOST'; item.append(badge); }
    else if (user.is_moderator) { const badge = document.createElement('span'); badge.className = 'member-badge moderator-badge'; badge.textContent = 'MOD'; item.append(badge); }
    if (room.controller_id === user.id) { const badge = document.createElement('span'); badge.className = 'member-badge'; badge.textContent = 'CONTROL'; item.append(badge); }
    list.append(item);
  }
  const mode = $('#control-mode');
  mode.textContent = room.control_mode === 'shared' ? 'SHARED' : 'HANDOFF';
  mode.title = me.is_admin ? 'Click to change room control mode' : 'Control mode';
  mode.disabled = !me.is_admin;
  mode.style.opacity = me.is_admin ? '1' : '.7';
  if ((room.streaming_backend || 'neko') !== 'go2rtc') $('#keyboard-toggle').hidden = true;
  if (room.desktop_available && !playerHidden && !desktopIsOpen) setDesktopOpen(true);
  $('#admin-open').hidden = !me.is_admin;
  $('#smb-open').hidden = !me.is_admin;
  $('#admin-tools').hidden = !me.is_admin;
  $('#chat-clear').hidden = !me.is_admin;
  const canChat = me.chat_enabled !== false;
  $('#chat-form').hidden = !canChat;
  $('#chat-restricted-notice').hidden = canChat;
  if (!canChat) {
    $('#gif-bookmark-picker').hidden = true;
    $('#gif-bookmark-toggle').setAttribute('aria-expanded', 'false');
  }
  $('#wallpaper-file').closest('.wallpaper-upload').hidden = !me.is_admin;
  $('#invite-tools').hidden = !me.is_admin;
  const guest = Boolean(me.is_guest);
  $('#add-form').hidden = guest;
  $('#queue-controls-toggle').hidden = guest;
  document.querySelectorAll('.transport-button, #seek, #autoplay-tool-toggle, [data-action="close"]').forEach((control) => { control.disabled = guest; });
  const box = $('#controller-box');
  box.hidden = room.control_mode !== 'controller';
  box.replaceChildren();
  if (!box.hidden) {
    const status = document.createElement('div'); status.className = 'muted';
    status.textContent = room.controller_id ? (room.users.find((u) => u.id === room.controller_id)?.nickname + ' has control') : 'No one has control yet.';
    box.append(status);
    if (!room.can_control && !me.is_guest) {
      const claim = document.createElement('button'); claim.className = 'button subtle'; claim.style.width = '100%'; claim.style.marginTop = '9px'; claim.textContent = 'Take control';
      claim.addEventListener('click', async () => { try { await post('/api/control/claim'); await refreshRoom(); notify('You have control'); } catch (e) { notify(e.message); } }); box.append(claim);
    }
    if (room.can_control || me.is_admin) {
      const select = document.createElement('select'); select.className = 'handoff-select'; select.setAttribute('aria-label', 'Hand off control to');
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Hand off control to…'; select.append(placeholder);
      for (const target of room.users) { if (target.id === me.id || !target.online || target.is_guest) continue; const option = document.createElement('option'); option.value = target.id; option.textContent = target.nickname; select.append(option); }
      select.addEventListener('change', async () => { if (!select.value) return; try { await post('/api/control/handoff', { user_id: select.value }); await refreshRoom(); notify('Control handed off'); } catch (e) { notify(e.message); } }); box.append(select);
    }
  }
  const signature = room.messages.map((message) => message.id).join(',');
  processChatNotifications(room.messages || []);
  if (signature !== latestMessages) { latestMessages = signature; renderMessages(room.messages); }
  updateMyProfile();
}

const chatMediaRequests = new Map();

function loadChatMediaPreview(preview) {
  const sourceUrl = preview.dataset.sourceUrl;
  if (!sourceUrl || !preview.isConnected) return;
  const provider = 'Tenor';
  let pending = chatMediaRequests.get(sourceUrl);
  if (!pending) {
    pending = request(`/api/chat/preview?url=${encodeURIComponent(sourceUrl)}`).then((data) => data.media_url);
    chatMediaRequests.set(sourceUrl, pending);
    if (chatMediaRequests.size > 300) chatMediaRequests.delete(chatMediaRequests.keys().next().value);
  }
  pending.then((mediaUrl) => {
    if (!preview.isConnected) return;
    if (!mediaUrl) throw new Error(`${provider} did not provide a GIF URL`);
    const image = document.createElement('img'); image.className = 'chat-embedded-media'; image.src = mediaUrl; image.alt = `GIF shared from ${provider}`; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      const fallback = document.createElement('a'); fallback.href = sourceUrl; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer'; fallback.textContent = `GIF unavailable · open on ${provider}`;
      image.replaceWith(fallback);
    }, { once: true });
    preview.replaceWith(image);
  }).catch(() => {
    if (!preview.isConnected) return;
    const fallback = document.createElement('a'); fallback.href = sourceUrl; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer'; fallback.textContent = `GIF unavailable · open on ${provider}`;
    preview.replaceChildren(fallback); preview.classList.add('chat-image-error');
  });
}

const chatPreviewObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) { chatPreviewObserver.unobserve(entry.target); loadChatMediaPreview(entry.target); }
  }), { root: $('#chat-messages'), rootMargin: '120px' })
  : null;

const chatLinkMetadata = new Map();
let chatLinkTooltip = null;
let hoveredChatLink = null;

function chatVideoLink(value) {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (host === 'twitch.tv' && /^\/(?:directory|downloads|settings|subscriptions|inventory|wallet|search|jobs|p|turbo)\/?$/i.test(url.pathname)) return null;
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
      const id = host === 'youtu.be' ? url.pathname.split('/')[1] : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1];
      if (/^[\w-]{11}$/.test(id || '')) return { provider: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` };
    }
    if ((host === 'twitch.tv' && /^\/(?:\w{1,25}|videos\/\d+|\w{1,25}\/clip\/[\w-]+)\/?$/.test(url.pathname)) || (host === 'clips.twitch.tv' && /^\/[\w-]+\/?$/.test(url.pathname))) return { provider: 'Twitch', url: `https://${url.hostname}${url.pathname}` };
  } catch {}
  return null;
}

function fetchChatLinkMetadata(media, details = false) {
  const key = `${details ? 'details' : 'title'}:${media.url}`;
  const cached = chatLinkMetadata.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = request(`/api/chat/link-preview?url=${encodeURIComponent(media.url)}${details ? '&details=1' : ''}`);
  chatLinkMetadata.set(key, { promise, expires: Date.now() + (media.provider === 'Twitch' ? 60_000 : 3600_000) });
  promise.then((data) => {
    if (details && !data.is_live && !Number.isFinite(data.duration_seconds)) {
      const entry = chatLinkMetadata.get(key);
      if (entry?.promise === promise) entry.expires = Date.now() + 60_000;
    }
  }, () => {});
  promise.catch(() => chatLinkMetadata.delete(key));
  if (chatLinkMetadata.size > 300) chatLinkMetadata.delete(chatLinkMetadata.keys().next().value);
  return promise;
}

function hideChatLinkPreview() {
  hoveredChatLink = null;
  if (chatLinkTooltip) chatLinkTooltip.hidden = true;
}

function showChatLinkPreview(link, media, metadata) {
  if (hoveredChatLink !== link || !link.isConnected) return;
  if (!chatLinkTooltip) {
    chatLinkTooltip = document.createElement('div'); chatLinkTooltip.className = 'chat-link-preview'; chatLinkTooltip.id = 'chat-link-preview'; chatLinkTooltip.setAttribute('role', 'tooltip'); document.body.append(chatLinkTooltip);
  }
  const nodes = [];
  const imageUrl = metadata.channel_avatar_url || metadata.thumbnail_url;
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    const image = document.createElement('img'); image.src = imageUrl; image.alt = ''; image.referrerPolicy = 'no-referrer';
    if (metadata.channel_avatar_url) image.className = 'channel-avatar';
    image.addEventListener('error', () => image.remove(), { once: true }); nodes.push(image);
  }
  const title = document.createElement('strong'); title.textContent = metadata.title || link.textContent; nodes.push(title);
  const info = document.createElement('span');
  info.textContent = `${media.provider}${metadata.uploader ? ` · ${metadata.uploader}` : ''} · ${metadata.is_live ? 'Live now' : Number.isFinite(metadata.duration_seconds) ? fmt(metadata.duration_seconds) : media.provider === 'YouTube' && link.chatDetailsLoading ? 'Loading length…' : 'Length unavailable'}`;
  nodes.push(info); chatLinkTooltip.replaceChildren(...nodes); chatLinkTooltip.hidden = false;
  link.setAttribute('aria-describedby', chatLinkTooltip.id);
  const rect = link.getBoundingClientRect(), tip = chatLinkTooltip.getBoundingClientRect();
  chatLinkTooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tip.width - 8))}px`;
  chatLinkTooltip.style.top = `${Math.max(8, rect.top >= tip.height + 12 ? rect.top - tip.height - 8 : Math.min(rect.bottom + 8, innerHeight - tip.height - 8))}px`;
}

function confirmQueueNext(entry) {
  const dialog = $('#queue-confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('#queue-confirm-title').textContent = entry.title || entry.url || '';
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function wireChatLink(link, media = null) {
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.addEventListener('click', async (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (media && !me?.is_guest && room?.can_control) {
      event.preventDefault(); hideChatLinkPreview();
      const metadata = link.chatMetadata || {};
      if (!await confirmQueueNext({ title: metadata.title, url: media.url })) return;
      if (await bridge('/queue_next', { url: media.url, local: true, quality: me?.quality || '720', title: metadata.title || undefined, preserve_queue: true })) notify('Added next in the queue');
    } else if (!confirm(`This link opens an external site:\n${link.href}\n\nOpen it?`)) event.preventDefault();
  });
  if (!media) return;
  link.classList.add('chat-video-title-link'); link.chatMetadata = {};
  link.loadChatTitle = async (details = false) => {
    if (details) link.chatDetailsLoading = true;
    try {
      const data = await fetchChatLinkMetadata(media, details);
      if (!link.isConnected) return;
      link.chatMetadata = { ...link.chatMetadata, ...data };
      if (data.title) link.textContent = data.title;
    } catch { /* Keep the original URL usable if metadata cannot be resolved. */ }
    finally {
      if (details) link.chatDetailsLoading = false;
      if (hoveredChatLink === link) showChatLinkPreview(link, media, link.chatMetadata);
    }
  };
  const preview = () => {
    hoveredChatLink = link;
    void link.loadChatTitle(media.provider === 'YouTube');
    showChatLinkPreview(link, media, link.chatMetadata);
  };
  link.addEventListener('mouseenter', preview); link.addEventListener('focus', preview);
  link.addEventListener('mouseleave', () => { if (hoveredChatLink === link) hideChatLinkPreview(); link.removeAttribute('aria-describedby'); });
  link.addEventListener('blur', () => { if (hoveredChatLink === link) hideChatLinkPreview(); link.removeAttribute('aria-describedby'); });
  if (chatLinkObserver) chatLinkObserver.observe(link); else void link.loadChatTitle();
}

const chatLinkObserver = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) { chatLinkObserver.unobserve(entry.target); void entry.target.loadChatTitle(); }
}, { rootMargin: '100px' }) : null;
document.addEventListener('scroll', hideChatLinkPreview, true);
window.addEventListener('resize', hideChatLinkPreview);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideChatLinkPreview(); });

function appendChatMessageContent(container, value) {
  const message = String(value || '');
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let cursor = 0;
  for (const match of message.matchAll(urlPattern)) {
    const rawUrl = match[0];
    const urlStart = match.index;
    const url = rawUrl.replace(/[),.!?;:]+$/, '');
    const trailing = rawUrl.slice(url.length);
    if (!url) continue;
    container.append(document.createTextNode(message.slice(cursor, urlStart)));
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    const hostname = parsed?.hostname.toLowerCase().replace(/^www\./, '') || '';
    const media = parsed && chatVideoLink(parsed.href);
    const tenorPage = hostname === 'tenor.com' && /^\/view\/.+-\d{4,}\/?$/i.test(parsed.pathname);
    const xPostId = ['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname)
      ? parsed.pathname.match(/\/(?:[^/]+\/status|i\/web\/status)\/(\d+)/i)?.[1]
      : null;
    if (media) {
      const link = document.createElement('a'); link.className = 'chat-text-link'; link.href = parsed.href; link.textContent = url;
      wireChatLink(link, media); container.append(link);
    } else if (tenorPage) {
      const preview = document.createElement('div'); preview.className = 'chat-media-loading'; preview.dataset.sourceUrl = parsed.href; preview.textContent = 'Loading GIF…';
      container.append(wrapFavoriteMedia(preview, parsed.href));
      if (chatPreviewObserver) chatPreviewObserver.observe(preview); else loadChatMediaPreview(preview);
    } else if (xPostId) {
      const preview = document.createElement('div');
      preview.className = 'chat-rich-embed x-embed';
      const load = document.createElement('button');
      load.type = 'button'; load.className = 'chat-embed-load';
      load.textContent = 'Load X post';
      load.addEventListener('click', async () => {
        const safeHref = parsed.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const embedMarkup = `<blockquote class="twitter-tweet"><a href="${safeHref}">View this post on X</a></blockquote><script async src="https://platform.twitter.com/widgets.js"></script>`;
        const frame = document.createElement('iframe');
        frame.className = 'chat-provider-frame';
        frame.title = 'X post';
        frame.loading = 'lazy';
        frame.referrerPolicy = 'no-referrer';
        frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
        frame.srcdoc = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent;color:#ddd;font:14px sans-serif}body{overflow:auto}blockquote{margin:0 auto!important}</style></head><body>${embedMarkup}</body></html>`;
        preview.replaceChildren(frame);
      }, { once: true });
      preview.append(load);
      container.append(wrapFavoriteMedia(preview, parsed.href));
    } else {
    const imageUrl = parsed && ['http:', 'https:'].includes(parsed.protocol) && /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(parsed.pathname);
    const videoUrl = parsed && ['http:', 'https:'].includes(parsed.protocol)
      && /\.(?:mp4|webm|m4v|mov|ogv|ogg|gifv)(?:$|[/?#])/i.test(parsed.href);
    const wrapsVideoSource = parsed && [...parsed.searchParams.values()].some((value) => /\.(?:mp4|webm|m4v|mov|ogv|ogg)(?:$|[/?#])/i.test(value));
    if (imageUrl) {
      const link = document.createElement('a');
      link.className = 'chat-image-link';
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.referrerPolicy = 'no-referrer';
      link.setAttribute('aria-label', 'Open shared image in a new tab');
      wireChatLink(link);
      const image = document.createElement('img');
      image.src = parsed.href;
      image.alt = 'Image shared in chat';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        link.replaceChildren(document.createTextNode('Could not load image · open link'));
        link.classList.add('chat-image-error');
      }, { once: true });
      link.append(image);
      container.append(wrapFavoriteMedia(link, parsed.href, wrapsVideoSource));
    } else if (videoUrl) {
      const link = document.createElement('a');
      link.className = 'chat-image-link chat-video-link'; link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; link.setAttribute('aria-label', 'Open shared video in a new tab');
      wireChatLink(link);
      const video = document.createElement('video'); video.src = parsed.href; video.autoplay = true; video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'none'; video.referrerPolicy = 'no-referrer'; video.setAttribute('aria-label', 'Video shared in chat');
      link.append(video); container.append(wrapFavoriteMedia(link, parsed.href, true));
    } else {
      if (parsed && ['http:', 'https:'].includes(parsed.protocol)) {
        const link = document.createElement('a'); link.className = 'chat-text-link'; link.href = parsed.href; link.textContent = url; wireChatLink(link); container.append(link);
      } else container.append(document.createTextNode(url));
    }
    }
    if (trailing) container.append(document.createTextNode(trailing));
    cursor = urlStart + rawUrl.length;
  }
  container.append(document.createTextNode(message.slice(cursor)));
}

function wrapFavoriteMedia(media, sourceUrl, isVideo = false) {
  const wrapper = document.createElement(isVideo ? 'div' : 'span'); wrapper.className = `chat-media-favorite-wrap${isVideo ? ' has-video' : ''}`;
  const favorite = document.createElement('button'); favorite.type = 'button'; favorite.className = 'mini-action chat-media-favorite';
  const saved = gifBookmarks.some((bookmark) => bookmark.url === sourceUrl);
  favorite.textContent = saved ? '★' : '☆';
  favorite.classList.toggle('is-saved', saved);
  favorite.title = saved ? 'Already bookmarked' : 'Bookmark this image or video';
  favorite.setAttribute('aria-label', favorite.title);
  favorite.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void saveGifBookmark(sourceUrl, favorite); });
  wrapper.append(media, favorite);
  return wrapper;
}

function renderMessages(messages) {
  const list = $('#chat-messages');
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.replaceChildren();
  for (const message of messages) {
    const isModerator = Boolean(me?.is_admin || me?.is_moderator);
    const canDelete = Boolean(message.user?.id === me?.id || me?.is_admin || (me?.is_moderator && !message.user?.is_admin));
    const canPin = isModerator;
    const mentionsMe = mentionedUsersForMessage(message).includes(me?.id);
    const isPinned = room?.pinned_message?.id === message.id;
    const item = document.createElement('div'); item.className = `chat-message${me?.is_admin ? ' admin-message' : ''}${canDelete ? ' has-delete' : ''}${canPin ? ' can-pin' : ''}${mentionsMe ? ' mentioned' : ''}${isPinned ? ' is-pinned' : ''}`;
    if (mentionsMe) item.setAttribute('aria-label', 'You were mentioned in this message');
    const avatarButton = document.createElement('button'); avatarButton.type = 'button'; avatarButton.className = 'chat-profile-trigger chat-avatar-trigger'; avatarButton.setAttribute('aria-label', `View ${message.user.nickname}'s profile`); avatarButton.append(avatarNode(message.user, true));
    avatarButton.addEventListener('click', () => openMemberProfile(message.user.id));
    item.append(avatarButton);
    const body = document.createElement('div');
    const head = document.createElement('div'); head.className = 'message-head';
    const name = document.createElement('button'); name.type = 'button'; name.className = 'chat-profile-trigger'; name.textContent = message.user.nickname; name.setAttribute('aria-label', `View ${message.user.nickname}'s profile`); name.addEventListener('click', () => openMemberProfile(message.user.id));
    const time = document.createElement('time'); time.textContent = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    head.append(name, time);
    const text = document.createElement('div'); text.className = 'message-text'; appendChatMessageContent(text, message.message);
    body.append(head, text); item.append(body);
    const bookmarks = [...text.querySelectorAll('.chat-media-favorite')];
    if (canDelete || canPin || bookmarks.length) {
      item.classList.add('has-message-actions');
      const actions = document.createElement('div'); actions.className = 'chat-message-actions';
      if (canDelete) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mini-action chat-delete'; remove.textContent = '×'; remove.title = message.user?.id === me?.id ? 'Delete your message' : 'Delete this message'; remove.setAttribute('aria-label', `Delete message from ${message.user.nickname}`);
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { await request(`/api/chat/${encodeURIComponent(message.id)}`, { method: 'DELETE' }); await refreshRoom(); }
          catch (error) { notify(`Could not delete message: ${error.message}`); remove.disabled = false; }
        });
        actions.append(remove);
      }
      if (canPin) {
        const pin = document.createElement('button'); pin.type = 'button'; pin.className = `mini-action chat-pin${isPinned ? ' is-pinned' : ''}`; pin.textContent = '📌'; pin.title = isPinned ? 'Unpin this message' : 'Pin this message'; pin.setAttribute('aria-label', pin.title); pin.setAttribute('aria-pressed', String(isPinned));
        pin.addEventListener('click', async () => {
          pin.disabled = true;
          try {
            if (isPinned) await request('/api/chat/pin', { method: 'DELETE' });
            else await post('/api/chat/pin', { message_id: message.id });
            await refreshRoom();
          } catch (error) { notify(`Could not ${isPinned ? 'unpin' : 'pin'} message: ${error.message}`); pin.disabled = false; }
        });
        actions.append(pin);
      }
      actions.append(...bookmarks);
      item.append(actions);
    }
    list.append(item);
  }
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
}

function renderPinnedMessage(message) {
  const card = $('#pinned-message');
  card.replaceChildren();
  card.hidden = !message;
  if (!message) return;
  const label = document.createElement('span'); label.className = 'pinned-message-label'; label.textContent = '📌 PINNED';
  const author = document.createElement('strong'); author.className = 'pinned-message-author'; author.textContent = message.user?.nickname || 'Room member';
  const text = document.createElement('div'); text.className = 'pinned-message-text'; appendChatMessageContent(text, message.message);
  card.append(label, author);
  if (me?.is_admin || me?.is_moderator) {
    const unpin = document.createElement('button'); unpin.type = 'button'; unpin.className = 'mini-action pinned-message-unpin'; unpin.textContent = '×'; unpin.title = 'Unpin this message'; unpin.setAttribute('aria-label', 'Unpin this message');
    unpin.addEventListener('click', async () => {
      unpin.disabled = true;
      try { await request('/api/chat/pin', { method: 'DELETE' }); await refreshRoom(); }
      catch (error) { notify(`Could not unpin message: ${error.message}`); unpin.disabled = false; }
    });
    card.append(unpin);
  }
  card.append(text);
}

function renderGifBookmarks() {
  const list = $('#gif-bookmark-list');
  list.replaceChildren();
  $('#gif-bookmark-count').textContent = `${gifBookmarks.length} / 5`;
  if (!gifBookmarks.length) {
    const empty = document.createElement('p'); empty.className = 'gif-bookmark-empty'; empty.textContent = 'Hover an image or video in chat and click its star to save it here.'; list.append(empty); return;
  }
  for (const bookmark of gifBookmarks) {
    const item = document.createElement('div'); item.className = 'gif-bookmark-item';
    const postButton = document.createElement('button'); postButton.type = 'button'; postButton.className = 'gif-bookmark-post'; postButton.title = 'Post this bookmark to chat'; postButton.setAttribute('aria-label', 'Post this bookmark to chat');
    const preview = document.createElement('div'); preview.className = 'gif-bookmark-preview';
    const showImage = (mediaUrl) => {
      const image = document.createElement('img'); image.src = mediaUrl; image.alt = 'Saved image'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { const fallback = document.createElement('span'); fallback.textContent = 'Preview unavailable'; image.replaceWith(fallback); }, { once: true });
      preview.replaceChildren(image);
    };
    let isTenor = false;
    let bookmarkPath = '';
    try { const parsed = new URL(bookmark.url); bookmarkPath = parsed.pathname; isTenor = parsed.hostname.toLowerCase().replace(/^www\./, '') === 'tenor.com' && /^\/view\/.+-\d{4,}\/?$/i.test(parsed.pathname); } catch {}
    if (isTenor) {
      preview.textContent = 'Loading GIF…';
      request(`/api/chat/preview?url=${encodeURIComponent(bookmark.url)}`).then((data) => data.media_url ? showImage(data.media_url) : (preview.textContent = 'Preview unavailable')).catch(() => { preview.textContent = 'Preview unavailable'; });
    } else if (/\.(?:mp4|webm|m4v|mov|ogv|ogg|gifv)(?:$|\/)/i.test(bookmarkPath)) {
      const video = document.createElement('video'); video.src = bookmark.url; video.autoplay = true; video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'metadata'; video.referrerPolicy = 'no-referrer'; preview.replaceChildren(video);
    } else if (/\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|\/)/i.test(bookmarkPath)) showImage(bookmark.url);
    else { const label = document.createElement('span'); label.textContent = 'Click to post'; preview.append(label); }
    postButton.append(preview);
    postButton.addEventListener('click', async () => {
      postButton.disabled = true;
      try { await post('/api/chat', { message: bookmark.url }); await refreshRoom(); }
      catch (error) { notify(`Could not post bookmark: ${error.message}`); }
      finally { postButton.disabled = false; }
    });
    const actions = document.createElement('div'); actions.className = 'gif-bookmark-actions';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mini-action'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove bookmark'); remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { const data = await request(`/api/profile/gif-bookmarks/${encodeURIComponent(bookmark.id)}`, { method: 'DELETE' }); gifBookmarks = data.bookmarks || []; renderGifBookmarks(); }
      catch (error) { notify(`Could not remove bookmark: ${error.message}`); remove.disabled = false; }
    });
    actions.append(remove); item.append(postButton, actions); list.append(item);
  }
}

async function loadGifBookmarks() {
  const data = await request('/api/profile/gif-bookmarks');
  gifBookmarks = data.bookmarks || [];
  renderGifBookmarks();
}

async function saveGifBookmark(url, button) {
  if (gifBookmarks.some((bookmark) => bookmark.url === url)) { button.textContent = '★'; button.classList.add('is-saved'); return; }
  button.disabled = true;
  try {
    const data = await post('/api/profile/gif-bookmarks', { url });
    gifBookmarks = data.bookmarks || [];
    button.textContent = '★'; button.classList.add('is-saved');
    button.title = 'Bookmarked'; button.setAttribute('aria-label', button.title);
    renderGifBookmarks();
  } catch (error) { notify(['you can save up to five GIFs', 'you can save up to five bookmarks'].includes(error.message) ? 'Your bookmarks are full. Remove one to save another.' : error.message); }
  finally { button.disabled = false; }
}

async function openMemberProfile(userId) {
  activeMemberProfileId = userId;
  activeMemberProfilePage = 1;
  clearTimeout(memberProfilePollTimer);
  const dialog = $('#member-profile-dialog');
  const kickButton = $('#member-kick');
  $('#member-chat-access').hidden = true;
  kickButton.hidden = true;
  $('#member-profile-name').textContent = 'Loading profile…';
  $('#member-profile-role').textContent = '';
  $('#member-profile-avatar').replaceChildren('?');
  $('#member-video-count').textContent = '…';
  $('#member-video-list').replaceChildren();
  memberProfileRenderedSignature = '';
  $('#member-video-pagination').hidden = true;
  dialog.showModal();
  await loadMemberProfilePage(userId, 1);
}

async function loadMemberProfilePage(userId, page, quiet = false) {
  const requestId = ++memberProfileRequestId;
  const kickButton = $('#member-kick');
  activeMemberProfileId = userId;
  activeMemberProfilePage = page;
  clearTimeout(memberProfilePollTimer);
  if (!quiet) {
    $('#member-video-list').replaceChildren();
    $('#member-video-count').textContent = '…';
  }
  try {
    const data = await request(`/api/members/${encodeURIComponent(userId)}/profile?page=${page}`);
    if (requestId !== memberProfileRequestId || !$('#member-profile-dialog').open) return;
    const user = data.user;
    $('#member-profile-name').textContent = user.nickname;
    $('#member-profile-role').textContent = user.is_admin ? 'Room admin' : user.is_moderator ? 'Moderator · room controls' : user.is_guest ? 'Guest · watch only' : 'Room user';
    kickButton.hidden = !(me?.is_admin || me?.is_moderator) || user.is_admin || (user.is_moderator && !me?.is_admin) || user.id === me?.id;
    const chatAccessButton = $('#member-chat-access');
    chatAccessButton.hidden = !(me?.is_admin || me?.is_moderator) || user.is_admin || (user.is_moderator && !me?.is_admin) || user.id === me?.id;
    chatAccessButton.textContent = user.chat_enabled === false ? 'Restore chat access' : 'Revoke chat access';
    chatAccessButton.dataset.enabled = String(user.chat_enabled !== false);
    $('#member-profile-role').textContent += user.chat_enabled === false ? ' · chat disabled' : '';
    const avatar = avatarNode(user); avatar.classList.remove('tiny');
    $('#member-profile-avatar').replaceChildren(...avatar.childNodes);
    const videos = data.videos || [];
    $('#member-video-count').textContent = `${data.total || 0} ${(data.total || 0) === 1 ? 'ITEM' : 'ITEMS'}`;
    const pagination = $('#member-video-pagination');
    pagination.hidden = (data.page_count || 0) <= 1;
    $('#member-video-page-label').textContent = `Page ${data.page_count ? data.page : 0} of ${data.page_count || 0}`;
    $('#member-video-prev').disabled = (data.page || 1) <= 1;
    $('#member-video-next').disabled = (data.page || 1) >= (data.page_count || 1);
    const list = $('#member-video-list');
    const renderedSignature = JSON.stringify(videos.map((video) => [video.id, video.title, video.uploader, video.thumbnail_url, video.duration_seconds]));
    if (!quiet || renderedSignature !== memberProfileRenderedSignature) {
      list.replaceChildren();
      memberProfileRenderedSignature = renderedSignature;
      if (!videos.length) {
        const empty = document.createElement('p'); empty.className = 'muted member-video-empty'; empty.textContent = 'Videos this person adds to the room will appear here.'; list.append(empty);
      }
      for (const [index, video] of videos.entries()) {
        const row = document.createElement('div'); row.className = 'member-video-item';
        appendThumbnail(row, video.thumbnail_url || youtubeThumbnail(video.url));
        const externalUrl = externalVideoUrl(video.url);
        const link = document.createElement('a'); link.className = 'member-video-link';
        if (externalUrl) { link.href = externalUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        else link.setAttribute('aria-disabled', 'true');
        const title = document.createElement('strong'); title.className = 'queue-title'; title.textContent = video.title || (data.metadata_pending ? 'Resolving video title…' : pendingTitle(video));
        const metadata = queueMetadataLine({ ...video, queued_by_name: user.nickname });
        const number = document.createElement('span'); number.className = 'queue-index'; number.textContent = String((data.page - 1) * 10 + index + 1).padStart(2, '0');
        link.append(title, metadata); link.addEventListener('click', async (event) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          if (me?.is_guest || !room?.can_control) {
            if (!confirm(`This link opens an external site:\n${link.href}\n\nOpen it?`)) event.preventDefault();
            return;
          }
          event.preventDefault();
          await playHistoryItem(video);
        });
        row.title = new Date(video.submitted_at).toLocaleString();
        row.append(number, link); list.append(row);
      }
    }
    if (data.metadata_pending) {
      memberProfilePollTimer = setTimeout(() => {
        if ($('#member-profile-dialog').open && activeMemberProfileId === userId && activeMemberProfilePage === page) {
          void loadMemberProfilePage(userId, page, true);
        }
      }, 2500);
    }
  } catch (error) {
    if (requestId !== memberProfileRequestId || !$('#member-profile-dialog').open) return;
    $('#member-profile-name').textContent = 'Could not load profile';
    $('#member-video-count').textContent = '—';
    const message = document.createElement('p'); message.className = 'muted member-video-empty'; message.textContent = error.message; $('#member-video-list').replaceChildren(message);
  }
}

$('#member-video-prev').addEventListener('click', () => {
  if (activeMemberProfilePage > 1) void loadMemberProfilePage(activeMemberProfileId, activeMemberProfilePage - 1);
});
$('#member-video-next').addEventListener('click', () => {
  void loadMemberProfilePage(activeMemberProfileId, activeMemberProfilePage + 1);
});
$('#member-profile-dialog').addEventListener('close', () => {
  clearTimeout(memberProfilePollTimer);
  memberProfileRequestId += 1;
});

$('#member-kick').addEventListener('click', async () => {
  const target = room?.users.find((user) => user.id === activeMemberProfileId);
  if (!(me?.is_admin || me?.is_moderator) || !target || target.is_admin || (target.is_moderator && !me?.is_admin) || target.id === me.id) return;
  if (!confirm(`Kick ${target.nickname} out of the room? They can sign in again later.`)) return;
  try {
    await post(`/api/admin/members/${encodeURIComponent(target.id)}/kick`);
    $('#member-profile-dialog').close();
    await refreshRoom();
    notify(`${target.nickname} was kicked from the room`);
  } catch (error) { notify(`Could not kick member: ${error.message}`); }
});

$('#member-chat-access').addEventListener('click', async () => {
  const target = room?.users.find((user) => user.id === activeMemberProfileId);
  const button = $('#member-chat-access');
  if (!(me?.is_admin || me?.is_moderator) || !target || target.is_admin || (target.is_moderator && !me?.is_admin) || target.id === me.id) return;
  const enabled = button.dataset.enabled !== 'true';
  const action = enabled ? 'restore' : 'revoke';
  if (!confirm(`${action === 'revoke' ? 'Revoke' : 'Restore'} chat access for ${target.nickname}? ${action === 'revoke' ? 'They will still be able to read messages.' : ''}`)) return;
  button.disabled = true;
  try {
    await request(`/api/admin/members/${encodeURIComponent(target.id)}/chat-access`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    await refreshRoom();
    await loadMemberProfilePage(target.id, activeMemberProfilePage);
    notify(enabled ? `Chat access restored for ${target.nickname}` : `Chat access revoked for ${target.nickname}`);
  } catch (error) { notify(`Could not change chat access: ${error.message}`); }
  finally { button.disabled = false; }
});

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), rest = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${m}:${String(rest).padStart(2, '0')}`;
}

async function refreshStatus() {
  try {
    playback = await request('/api/bridge/status');
    setConnection(true, 'MediaBridge connected');
    renderPlayback();
  } catch (error) {
    playback = null;
    setConnection(false, 'MediaBridge unavailable');
    if (!$('#admin-bridge-status').dataset.notified) {
      $('#admin-bridge-status').dataset.notified = '1';
      console.warn('MediaBridge status:', error.message);
    }
  }
}

let hardwareStatusBusy = false;
let hardwareStatusSignature = '';
async function refreshAdminHardware() {
  if (!me?.is_admin || hardwareStatusBusy || !$('#hardware-tools').open) return;
  hardwareStatusBusy = true;
  const container = $('#hardware-status');
  try {
    const data = await request('/api/admin/hardware');
    const signature = JSON.stringify(data);
    if (signature === hardwareStatusSignature) return;
    const diagnosticsOpen = container.querySelector('details')?.open || false;
    const fragment = document.createDocumentFragment();
    const row = (label, value) => {
      const item = document.createElement('div'); item.className = 'hardware-row';
      const title = document.createElement('strong'); title.textContent = label;
      const text = document.createElement('span'); text.textContent = value || 'Not reported';
      item.append(title, text); fragment.append(item);
    };
    row('Streaming backend', data.backend === 'go2rtc' ? 'go2rtc · HTTP stream' : 'Neko · WebRTC');
    row('Processor', `${data.cpu_model} · ${data.logical_cpus} logical CPUs · ${data.architecture}`);
    row('Startup capture check', `${data.startup.status || 'checking'} · ${data.startup.reason || 'Waiting for results'}`);
    row('Stream service', data.stream_available ? 'Available' : 'Not available yet');
    row('Selected encoder', data.encoder);
    row('Encoder preference', data.startup.requested || 'Automatic');
    if (data.startup.checked_at) row('Checked at', new Date(data.startup.checked_at).toLocaleString());
    if (data.startup.device) row('Encoder device', data.startup.device);
    if (data.startup.rate_mode) row('Bitrate control', data.startup.rate_mode === 'CQP' ? 'CQP · bitrate target is approximate' : data.startup.rate_mode);
    if (data.startup.fallback_reason) row('Software fallback reason', data.startup.fallback_reason);
    row('mpv decoder preference', data.decoding.requested);
    row('Current mpv decoder', data.decoding.active === 'idle' ? 'Idle · play a video to check decoding' : data.decoding.active);
    if (data.decoding.active === 'software') row('Decoding details', data.decoding.requested === 'no' ? 'Software decoding is explicitly selected.' : 'MediaBridge reports software decoding for this video. A detailed fallback reason was not supplied.');
    if (data.decoding.error) row('Playback error', data.decoding.error);
    if (!data.devices.length) row('Visible GPUs', 'No GPU device detected inside the container. Check Docker device passthrough if hardware acceleration is expected.');
    for (const device of data.devices) row('Visible GPU', `${device.model || device.vendor}${device.pci_id ? ` (${device.pci_id})` : ''} · ${device.device}${device.driver ? ` · driver ${device.driver}` : ''}${device.accessible === true ? ' · device accessible' : device.accessible === false ? ' · device permission denied' : ''}`);
    if (data.startup.diagnostics) {
      const details = document.createElement('details');
      details.open = diagnosticsOpen;
      const summary = document.createElement('summary'); summary.textContent = 'Startup diagnostics';
      const log = document.createElement('pre'); log.textContent = data.startup.diagnostics;
      details.append(summary, log); fragment.append(details);
    }
    const note = document.createElement('p'); note.className = 'muted tiny-copy'; note.textContent = data.note; fragment.append(note);
    container.replaceChildren(fragment);
    hardwareStatusSignature = signature;
  } catch (error) { hardwareStatusSignature = ''; container.textContent = `Could not load hardware status: ${error.message}`; }
  finally { hardwareStatusBusy = false; }
}

$('#hardware-tools').addEventListener('toggle', () => { void refreshAdminHardware(); });
$('#hardware-refresh').addEventListener('click', () => { void refreshAdminHardware(); });

function renderPlayback() {
  if (!playback) return;
  renderAutoplayState(Boolean(playback.autoplay_enabled));
  const decodeStatus = $('#decode-status');
  const decoder = playback.hardware_decoder;
  const hasMedia = Boolean(playback.current || playback.playing || playback.mirroring);
  decodeStatus.classList.toggle('active', Boolean(decoder && decoder !== 'software' && decoder !== 'checking'));
  decodeStatus.classList.toggle('pending', decoder === 'checking');
  const mpvStatus = !hasMedia ? 'MPV · IDLE' : decoder === 'software' ? 'MPV · SOFTWARE' : decoder === 'checking' ? 'MPV · CHECKING' : decoder ? `HW DECODE · ${decoder.toUpperCase()}` : 'HW DECODE · N/A';
  const streamEncoder = room?.desktop_encoder || 'starting';
  decodeStatus.textContent = `${mpvStatus} · STREAM ${streamEncoder.toUpperCase()}`;
  decodeStatus.title = `mpv decoder: ${decoder || 'not reported'}; desktop stream encoder: ${streamEncoder}. These are separate hardware paths.`;
  const title = playback.title || playback.current || (playback.mirroring ? 'Moonlight stream' : 'Nothing playing yet');
  renderTopNowPlaying(title, playback.artwork_url || playback.thumbnail_url || youtubeThumbnail(playback.media_url || playback.current || ''));
  $('#now-title').textContent = title;
  $('#now-subtitle').textContent = playback.playback_error && !playback.playing
    ? playback.playback_error
    : (playback.artist || playback.album || playback.media_url || 'Add a link to start the room.');
  const stateText = playback.playback_state || (playback.playing ? 'playing' : 'idle');
  $('#playback-state').textContent = stateText.replaceAll('_', ' ');
  $('#playing-pip').classList.toggle('active', Boolean(playback.playing));
  const playButton = $('.play-button');
  const isPlaying = stateText === 'playing' || (stateText !== 'paused' && Boolean(playback.playing));
  playButton.textContent = isPlaying ? 'Ⅱ' : '▶';
  playButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  playButton.title = isPlaying ? 'Pause' : 'Play';
  const position = Number(playback.position_seconds) || 0;
  const duration = Number(playback.duration_seconds) || 0;
  $('#playback-time').textContent = duration ? `${fmt(position)} / ${fmt(duration)}` : fmt(position);
  $('#seek-current').textContent = fmt(position);
  $('#seek-duration').textContent = fmt(duration);
  const seek = $('#seek');
  if (duration > 0) {
    seek.max = String(duration);
    if (document.activeElement !== seek) seek.value = String(Math.min(position, duration));
    seek.disabled = playback.can_seek === false;
    seek.style.setProperty('--fill', `${Math.min(position / duration * 100, 100)}%`);
  } else { seek.max = '100'; seek.value = '0'; seek.disabled = true; seek.style.setProperty('--fill', '0%'); }
  const hasReportedHostVolume = playback.volume !== null && playback.volume !== undefined && Number.isFinite(Number(playback.volume));
  const hasActiveHostPlayer = Boolean(playback.current || playback.playing || playback.mirroring)
    && !['idle', 'stopped'].includes(stateText);
  const hostVolumeInput = $('#host-volume');
  hostVolumeInput.disabled = !(hasReportedHostVolume && hasActiveHostPlayer);
  const hostVolume = Number(playback.volume);
  if (hasReportedHostVolume) {
    if (document.activeElement !== $('#host-volume')) $('#host-volume').value = String(Math.round(hostVolume * 100));
    $('#host-volume-label').textContent = `${Math.round(hostVolume * 100)}%`;
    $('#host-volume').style.setProperty('--fill', `${hostVolume * 100}%`);
  } else {
    $('#host-volume-label').textContent = hasActiveHostPlayer ? 'N/A' : 'Idle';
  }
  const queueItems = playback.queue_items || (playback.queued || []).map((url) => ({ url }));
  const queueSignature = JSON.stringify(queueItems);
  if (queueSignature !== renderedQueueSignature) { renderedQueueSignature = queueSignature; renderQueue(queueItems); }
  const historyItems = visibleHistoryItems();
  const historySignature = JSON.stringify(historyItems);
  if (historySignature !== renderedHistorySignature) { renderedHistorySignature = historySignature; renderHistory(historyItems); }
}

let topTickerAnimationFrame = 0;
let topTickerLastFrame = 0;
let topTickerOffset = 0;
let topTickerDistance = 0;

function animateTopTicker(timestamp) {
  const windowEl = $('#top-now-window'), track = $('#top-now-track');
  if (!windowEl.classList.contains('scrolling')) { topTickerAnimationFrame = 0; topTickerLastFrame = 0; return; }
  if (topTickerLastFrame) topTickerOffset += Math.min(50, timestamp - topTickerLastFrame) * 0.035;
  topTickerLastFrame = timestamp;
  if (topTickerDistance > 0 && topTickerOffset >= topTickerDistance) topTickerOffset -= topTickerDistance;
  track.style.transform = `translateX(${-topTickerOffset}px)`;
  topTickerAnimationFrame = requestAnimationFrame(animateTopTicker);
}

function measureTopNowPlaying() {
  const windowEl = $('#top-now-window'), track = $('#top-now-track'), first = $('#top-now-title');
  const viewportWidth = windowEl.getBoundingClientRect().width;
  const titleWidth = first.getBoundingClientRect().width;
  const overflows = viewportWidth > 0 && titleWidth > viewportWidth + 2;
  windowEl.classList.toggle('scrolling', overflows);
  if (overflows) {
    topTickerDistance = titleWidth;
    if (!topTickerAnimationFrame) topTickerAnimationFrame = requestAnimationFrame(animateTopTicker);
  } else {
    topTickerOffset = 0;
    topTickerDistance = 0;
    topTickerLastFrame = 0;
    track.style.transform = '';
    if (topTickerAnimationFrame) cancelAnimationFrame(topTickerAnimationFrame);
    topTickerAnimationFrame = 0;
  }
}

function renderTopNowPlaying(title, thumbnailUrl) {
  const normalizedTitle = title || 'Nothing playing yet';
  const normalizedThumbnail = thumbnailUrl || '';
  const signature = `${normalizedTitle}\n${normalizedThumbnail}`;
  const image = $('#top-now-thumbnail');
  const externalUrl = externalVideoUrl(playback?.media_url || playback?.current || '');
  const nowLink = $('#top-now-link');
  if (externalUrl) {
    nowLink.href = externalUrl;
    nowLink.removeAttribute('aria-disabled');
  } else {
    nowLink.removeAttribute('href');
    nowLink.setAttribute('aria-disabled', 'true');
  }
  if (signature !== topNowPlayingSignature) {
    topNowPlayingSignature = signature;
    $('#top-now-title').textContent = normalizedTitle;
    $('#top-now-title-copy').textContent = normalizedTitle;
    const windowEl = $('#top-now-window');
    windowEl.classList.remove('scrolling');
    topTickerOffset = 0;
    topTickerLastFrame = 0;
    $('#top-now-track').style.transform = '';
    if (normalizedThumbnail && image.src !== normalizedThumbnail) {
      image.hidden = false;
      image.onerror = () => { image.hidden = true; };
      image.src = normalizedThumbnail;
    } else if (!normalizedThumbnail) {
      image.removeAttribute('src');
      image.hidden = true;
    }
    requestAnimationFrame(measureTopNowPlaying);
  }
}

window.addEventListener('resize', measureTopNowPlaying);
let topNowResizeObserver = null;
if ('ResizeObserver' in window) {
  topNowResizeObserver = new ResizeObserver(measureTopNowPlaying);
  topNowResizeObserver.observe($('#top-now-window'));
}
document.fonts?.ready?.then(measureTopNowPlaying);

$('#top-now-link').addEventListener('click', (event) => {
  if (event.button === 0) event.preventDefault();
});

function renderAutoplayState(enabled) {
  const errorDetails = $('#autoplay-error-details');
  errorDetails.hidden = !me?.is_admin || !playback?.autoplay_error;
  $('#autoplay-error-text').textContent = me?.is_admin ? playback?.autoplay_error || '' : '';
  const toolButton = $('#autoplay-tool-toggle');
  const adminButton = $('#autoplay-toggle');
  toolButton.classList.toggle('is-active', enabled);
  toolButton.setAttribute('aria-pressed', String(enabled));
  toolButton.title = enabled ? 'Autoplay is on' : 'Autoplay is off';
  $('#autoplay-tool-status').textContent = enabled ? 'On · YouTube Mix when queue ends' : 'Continue with YouTube Mix';
  if (enabled && playback?.autoplay_loading) $('#autoplay-tool-status').textContent = 'Finding YouTube Mix videos…';
  else if (enabled && playback?.autoplay_error) {
    $('#autoplay-tool-status').textContent = 'Mix unavailable · toggle to retry';
    toolButton.title = me?.is_admin ? playback.autoplay_error : 'Mix lookup failed';
  }
  else if (enabled) {
    const queued = playback?.queue_items || playback?.queued || [];
    const currentUrl = playback?.media_url || playback?.current;
    $('#autoplay-tool-status').textContent = queued.some((item) => item.autoplay_generated) ? 'YouTube Mix videos queued'
      : queued.length ? 'Waiting for queued videos to finish'
      : !currentUrl ? 'Waiting for a YouTube video'
      : chatVideoLink(currentUrl)?.provider !== 'YouTube' ? 'Autoplay needs a YouTube video'
      : 'Waiting for YouTube Mix lookup';
  }
  if (enabled && playback?.autoplay_loading && playback?.autoplay_error && me?.is_admin) toolButton.title = `Retrying. Last error: ${playback.autoplay_error}`;
  if (playback?.autoplay_status) $('#autoplay-tool-status').textContent = playback.autoplay_status;
  adminButton.classList.toggle('is-active', enabled);
  adminButton.setAttribute('aria-pressed', String(enabled));
  adminButton.textContent = enabled ? 'Turn autoplay off' : 'Turn autoplay on';
}

async function setAutoplayEnabled(enabled) {
  const previous = Boolean(playback?.autoplay_enabled);
  if (playback) playback = { ...playback, autoplay_enabled: enabled };
  renderAutoplayState(enabled);
  try {
    await post('/api/bridge/autoplay', {
      enabled,
      duration_minutes: Math.max(1, Number($('#autoplay-minutes').value) || 60),
    });
    notify(enabled ? 'Autoplay enabled' : 'Autoplay disabled');
    await refreshStatus();
  } catch (error) {
    if (playback) playback = { ...playback, autoplay_enabled: previous };
    renderAutoplayState(previous);
    notify(`Could not update autoplay: ${error.message}`);
  }
}

function visibleHistoryItems() {
  const items = playback?.history_items || [];
  const currentUrl = playback?.media_url || playback?.current;
  const state = playback?.playback_state || (playback?.playing ? 'playing' : 'idle');
  if (!currentUrl || ['idle', 'stopped'].includes(state)) return items;
  const current = {
    url: currentUrl,
    title: playback.title || null,
    uploader: playback.artist || null,
    thumbnail_url: playback.artwork_url || null,
    local: Boolean(playback.local),
    quality: playback.quality || null,
    duration_seconds: playback.duration_seconds,
    queued_by_name: playback.queued_by_name,
  };
  if (items[0]?.url === current.url) return items;
  return [current, ...items];
}

const mediaChannelWindows = new Set();
function measureMediaChannel(windowEl) {
  if (!windowEl.isConnected) { mediaChannelObserver?.unobserve(windowEl); mediaChannelWindows.delete(windowEl); return; }
  const track = windowEl.firstElementChild;
  const width = track.firstElementChild.getBoundingClientRect().width;
  const overflowing = windowEl.clientWidth > 0 && width > windowEl.clientWidth + 2;
  track.classList.toggle('is-scrolling', overflowing);
  track.style.setProperty('--channel-distance', `${-(width + 24)}px`);
  track.style.setProperty('--channel-duration', `${(width + 24) / 35}s`);
}
const mediaChannelObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((entries) => entries.forEach((entry) => measureMediaChannel(entry.target))) : null;
function queueMetadataLine(entry, autoplay = false) {
  for (const element of mediaChannelWindows) if (!element.isConnected) { mediaChannelObserver?.unobserve(element); mediaChannelWindows.delete(element); }
  const line = document.createElement('span'); line.className = 'queue-url media-row-meta';
  const by = document.createElement('span'); by.className = 'media-row-submitter';
  by.textContent = autoplay ? '✨' : entry.queued_by_name || 'Unknown user';
  by.title = autoplay ? 'Added by autoplay' : `Queued by ${by.textContent}`;
  const separator = document.createElement('span'); separator.className = 'media-row-separator'; separator.textContent = '·';
  const channel = document.createElement('span'); channel.className = 'media-channel-window';
  channel.title = entry.uploader || 'Channel unavailable';
  const track = document.createElement('span'); track.className = 'media-channel-track';
  const name = document.createElement('span'); name.textContent = entry.uploader || 'Channel unavailable';
  const copy = name.cloneNode(true); copy.className = 'media-channel-copy'; copy.setAttribute('aria-hidden', 'true');
  track.append(name, copy); channel.append(track);
  const duration = document.createElement('span'); duration.className = 'media-row-duration';
  const seconds = entry.duration_seconds;
  duration.textContent = Number.isFinite(seconds) && seconds >= 0 ? seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(Math.floor(seconds) % 60).padStart(2, '0')}` : fmt(seconds) : '—';
  duration.title = Number.isFinite(seconds) ? 'Video duration' : 'Duration unavailable';
  line.append(by, separator, channel, duration);
  mediaChannelWindows.add(channel); mediaChannelObserver?.observe(channel);
  requestAnimationFrame(() => measureMediaChannel(channel));
  return line;
}

function appendThumbnail(row, url) {
  if (!url) return;
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return; }
  catch { return; }
  const image = document.createElement('img');
  image.className = 'row-thumbnail'; image.src = url; image.alt = ''; image.loading = 'lazy';
  image.onerror = () => image.remove();
  row.append(image);
}

function youtubeThumbnail(mediaUrl) {
  try {
    const parsed = new URL(mediaUrl);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase())) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const id = parsed.hostname.toLowerCase() === 'youtu.be'
      ? parts[0]
      : parsed.searchParams.get('v') || (['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : null);
    return id && /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  } catch { return null; }
}

function itemThumbnail(entry) {
  return entry.thumbnail_url || youtubeThumbnail(entry.url);
}

function externalVideoUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function pendingTitle(entry) {
  if (!entry.metadata_error) return 'Resolving video title…';
  try { return `Media from ${new URL(entry.url).hostname.replace(/^www\./, '')}`; }
  catch { return 'Media link'; }
}

function renderQueue(items) {
  let total = 0, unknown = 0;
  for (const item of items) {
    if (Number.isFinite(item.duration_seconds) && item.duration_seconds >= 0) total += item.duration_seconds;
    else unknown += 1;
    if (total > 86400) break;
  }
  const durationBadge = $('#queue-duration');
  const seconds = Math.floor(total);
  const formatted = seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : fmt(seconds);
  durationBadge.textContent = total > 86400 ? 'More than a day' : unknown ? (total > 0 ? `${formatted}+` : '…') : formatted;
  durationBadge.title = total > 86400 ? 'Queued videos exceed 24 hours; further duration lookups paused' : unknown ? `Known duration; ${unknown} item(s) pending or without a fixed length` : 'Total queued video duration';
  $('#queue-count').textContent = `${items.length} ${items.length === 1 ? 'ITEM' : 'ITEMS'}`;
  const list = $('#queue-list'); list.replaceChildren();
  if (!items.length) { const empty = document.createElement('div'); empty.className = 'empty-queue'; empty.textContent = 'The queue is empty. Add a link above to get started.'; list.append(empty); return; }
  items.forEach((entry, index) => {
    const row = document.createElement('div'); row.className = 'queue-item';
    row.draggable = !me?.is_guest;
    appendThumbnail(row, itemThumbnail(entry));
    const number = document.createElement('span'); number.className = 'queue-index'; number.textContent = String(index + 1).padStart(2, '0');
    const info = document.createElement('div'); info.className = 'queue-info';
    const name = document.createElement('div'); name.className = 'queue-title'; name.textContent = entry.title || pendingTitle(entry);
    if (entry.metadata_error) name.title = entry.metadata_error;
    const url = queueMetadataLine(entry, entry.autoplay_generated);
    info.append(name, url);
    const controlsHidden = !me?.is_guest && $('#queue-panel').classList.contains('queue-controls-hidden');
    const externalUrl = externalVideoUrl(entry.url);
    let titleContent = info;
    if (externalUrl) {
      const link = document.createElement('a');
      link.className = 'queue-external-link';
      link.href = externalUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Open ${entry.title || entry.url} externally`);
      link.append(info);
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (me?.is_guest) return;
        event.preventDefault();
        unlockDesktopAudio();
        bridge('/queue/play', { index });
      });
      titleContent = link;
    }
    const actions = document.createElement('div'); actions.className = 'queue-actions';
    const addAction = (label, title, action, value = {}) => { const button = document.createElement('button'); button.className = 'mini-action'; button.textContent = label; button.title = title; button.addEventListener('click', () => { unlockDesktopAudio(); bridge(action, value); }); actions.append(button); };
    if (!me?.is_guest) {
      if (entry.autoplay_generated) addAction('＋', 'Keep this item in the queue', '/queue/promote', { index });
      if (index > 0) addAction('↑', 'Move up', '/queue/move', { index, to: index - 1 });
      if (index < items.length - 1) addAction('↓', 'Move down', '/queue/move', { index, to: index + 1 });
      addAction('×', 'Remove', '/queue/remove', { index });
    } else actions.hidden = true;
    if (controlsHidden) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Play ${entry.title || entry.url} immediately`);
    }
    const playRow = () => {
      if (me?.is_guest) return;
      if (!$('#queue-panel').classList.contains('queue-controls-hidden')) return;
      unlockDesktopAudio();
      bridge('/queue/play', { index });
    };
    row.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      playRow();
    });
    row.addEventListener('keydown', (event) => {
      if (event.target.closest('a,button')) return;
      if ((event.key === 'Enter' || event.key === ' ') && $('#queue-panel').classList.contains('queue-controls-hidden')) {
        event.preventDefault(); playRow();
      }
    });
    row.addEventListener('dragstart', (event) => {
      if (event.target.closest('button')) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      row.classList.add('dragging');
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('dragleave', (event) => {
      if (row.contains(event.relatedTarget)) return;
      row.classList.remove('drop-before', 'drop-after');
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      if (me?.is_guest) return;
      const fromValue = event.dataTransfer?.getData('text/plain') || '';
      if (!/^\d+$/.test(fromValue)) return;
      const from = Number(fromValue);
      const after = event.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
      let to = index + (after ? 1 : 0);
      if (from < to) to -= 1;
      row.classList.remove('drop-before', 'drop-after');
      if (Number.isInteger(from) && from >= 0 && from < items.length && to >= 0 && to < items.length && from !== to) {
        bridge('/queue/move', { index: from, to });
      }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.drop-before,.drop-after').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
    });
    row.append(number, titleContent, actions); list.append(row);
  });
}

function setQueueControlsHidden(hidden) {
  const panel = $('#queue-panel'), toggle = $('#queue-controls-toggle');
  panel.classList.toggle('queue-controls-hidden', hidden);
  toggle.setAttribute('aria-pressed', String(hidden));
  toggle.setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} queue controls`);
  toggle.title = `${hidden ? 'Show' : 'Hide'} queue controls`;
  panel.querySelectorAll('.queue-item').forEach((row) => {
    if (hidden) {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
    } else {
      row.removeAttribute('tabindex');
      row.removeAttribute('role');
      row.removeAttribute('aria-label');
    }
  });
  const queueItems = playback?.queue_items || (playback?.queued || []).map((url) => ({ url }));
  if (playback) renderQueue(queueItems);
  try { localStorage.setItem('baka-inu-queue-controls-hidden', String(hidden)); } catch {}
}

$('#queue-controls-toggle').addEventListener('click', () => {
  setQueueControlsHidden(!$('#queue-panel').classList.contains('queue-controls-hidden'));
});
let queueControlsHidden = false;
try { queueControlsHidden = localStorage.getItem('baka-inu-queue-controls-hidden') === 'true'; } catch {}
setQueueControlsHidden(queueControlsHidden);

function renderHistory(items) {
  const pageSize = 10, pageCount = Math.max(1, Math.min(5, Math.ceil(items.length / pageSize)));
  historyPage = Math.min(historyPage, pageCount - 1);
  $('#history-count').textContent = `${items.length} ${items.length === 1 ? 'ITEM' : 'ITEMS'}`;
  $('#history-page-label').textContent = `Page ${historyPage + 1} of ${pageCount}`;
  $('#history-prev').disabled = historyPage === 0;
  $('#history-next').disabled = historyPage >= pageCount - 1;
  const list = $('#history-list'); list.replaceChildren();
  const pageItems = items.slice(historyPage * pageSize, historyPage * pageSize + pageSize);
  if (!pageItems.length) {
    const empty = document.createElement('div'); empty.className = 'empty-queue'; empty.textContent = 'Videos played in this room will appear here.'; list.append(empty); return;
  }
  pageItems.forEach((entry, index) => {
    const row = document.createElement('div'); row.className = 'history-item';
    appendThumbnail(row, itemThumbnail(entry));
    const number = document.createElement('span'); number.className = 'queue-index'; number.textContent = String(historyPage * pageSize + index + 1).padStart(2, '0');
    const play = document.createElement('a'); play.className = 'history-play'; play.target = '_blank'; play.rel = 'noopener noreferrer';
    const externalUrl = externalVideoUrl(entry.url);
    if (externalUrl) play.href = externalUrl;
    else play.setAttribute('aria-disabled', 'true');
    const info = document.createElement('span'); info.className = 'history-info';
    const title = document.createElement('strong'); title.className = 'queue-title'; title.textContent = entry.title || pendingTitle(entry);
    if (entry.metadata_error) title.title = entry.metadata_error;
    const url = queueMetadataLine(entry);
    info.append(title, url); play.append(info);
    play.title = `Queue ${entry.title || entry.url} next`;
    play.addEventListener('click', async (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (me?.is_guest || !room?.can_control) {
        if (!confirm(`This link opens an external site:\n${play.href}\n\nOpen it?`)) event.preventDefault();
        return;
      }
      event.preventDefault();
      await playHistoryItem(entry);
    });
    row.append(number, play);
    list.append(row);
  });
}

async function playHistoryItem(entry) {
  if (me?.is_guest || !room?.can_control || !await confirmQueueNext(entry)) return;
  try {
    unlockDesktopAudio();
    const item = { url: entry.url, local: Boolean(entry.local), quality: entry.quality || me.quality || '720' };
    await post('/api/bridge/queue_next', { ...item, preserve_queue: true });
    await refreshStatus();
    notify('Added next in the queue');
  } catch (error) { notify(`Could not queue history item: ${error.message}`); }
}

async function bridge(route, body = {}) {
  try {
    await post(`/api/bridge${route}`, body);
    await refreshStatus();
    if (route === '/close') notify('Playback and queue cleared');
    return true;
  } catch (error) { notify(error.message); return false; }
}

$('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  unlockDesktopAudio();
  const url = $('#media-url').value.trim();
  let action = $('#add-mode').value;
  let isPlaylist = false;
  try {
    const parsed = new URL(url);
    isPlaylist = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase()) && Boolean(parsed.searchParams.get('list'));
  } catch {}
  if (isPlaylist) action = ({ play: 'play_playlist', queue: 'queue_playlist', queue_next: 'queue_playlist_next' })[action] || action;
  const item = { url, local: $('#local-playback').checked, quality: $('#playback-quality').value };
  if (await bridge(`/${action}`, item)) $('#media-url').value = '';
});

function setRoomTab(tab) {
  const historyActive = tab === 'history';
  $('#chat-view').hidden = historyActive;
  $('#history-view').hidden = !historyActive;
  $('#chat-tab').classList.toggle('active', !historyActive);
  $('#chat-tab').setAttribute('aria-selected', String(!historyActive));
  $('#history-tab').classList.toggle('active', historyActive);
  $('#history-tab').setAttribute('aria-selected', String(historyActive));
}
$('#chat-tab').addEventListener('click', () => setRoomTab('chat'));
$('#history-tab').addEventListener('click', () => setRoomTab('history'));
$('#history-prev').addEventListener('click', () => { if (historyPage > 0) { historyPage--; renderHistory(visibleHistoryItems()); } });
$('#history-next').addEventListener('click', () => { if (historyPage < 4) { historyPage++; renderHistory(visibleHistoryItems()); } });

$('#playback-quality').addEventListener('change', async (event) => {
  const select = event.currentTarget;
  const previous = me.quality || '720';
  select.disabled = true;
  try {
    const result = await post('/api/profile', { quality: select.value });
    me = result.user;
    notify(`Playback preference saved · ${select.value === '2160' ? '4K' : `${select.value}p`}`);
  } catch (error) {
    select.value = previous;
    notify(`Could not save playback preference: ${error.message}`);
  } finally { select.disabled = false; }
});

// Transport buttons have their own handler below. Exclude them here so a
// play/pause click does not toggle mpv twice and appear to do nothing.
document.querySelectorAll('[data-action]:not(.transport-button)').forEach((button) => button.addEventListener('click', async () => {
  const action = button.dataset.action;
  if (action === 'close') {
    if (confirm('Stop playback and clear the queue?')) await bridge('/close');
  } else if (action === 'sleep') {
    if (confirm('Put the MediaBridge host to sleep?')) await bridge('/sleep');
  } else if (action === 'sunshine' || action === 'sunshine-pair') {
    const host = $('#sunshine-host').value.trim();
    if (!host) return notify('Enter a Sunshine host or IP first');
    await bridge(action === 'sunshine' ? '/sunshine' : '/sunshine/pair', { host, app: $('#sunshine-app').value.trim() || 'Desktop' });
  } else if (action.startsWith('zoom_') || ['previous', 'next', 'pause', 'resume', 'play_pause', 'rewind', 'forward'].includes(action)) {
    unlockDesktopAudio();
    await bridge(`/${action}`);
  }
}));

$('#autoplay-error-clear').addEventListener('click', async () => {
  if (!me?.is_admin) return;
  if (await bridge('/autoplay/error/clear')) {
    if (playback) playback.autoplay_error = null;
    $('#autoplay-error-details').open = false;
    renderAutoplayState(Boolean(playback?.autoplay_enabled));
  }
});
$('#autoplay-tool-toggle').addEventListener('click', () => setAutoplayEnabled(!playback?.autoplay_enabled));
$('#autoplay-toggle').addEventListener('click', () => setAutoplayEnabled(!playback?.autoplay_enabled));
document.querySelectorAll('.transport-button').forEach((button) => button.addEventListener('click', () => {
  unlockDesktopAudio();
  bridge(`/${button.dataset.action}`);
}));

$('#seek').addEventListener('input', (event) => {
  $('#seek-current').textContent = fmt(Number(event.target.value));
  event.target.style.setProperty('--fill', `${Number(event.target.value) / Number(event.target.max) * 100}%`);
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => bridge('/seek', { position: Number(event.target.value) }), 500);
});
$('#volume').addEventListener('input', (event) => {
  localAudioVolume = Number(event.target.value) / 100;
  $('#volume-label').textContent = `${Math.round(localAudioVolume * 100)}%`;
  event.target.style.setProperty('--fill', `${localAudioVolume * 100}%`);
  try { localStorage.setItem(LOCAL_AUDIO_VOLUME_KEY, String(localAudioVolume)); } catch {}
  applyLocalDesktopVolume();
});

$('#host-volume').addEventListener('input', (event) => {
  const volume = Number(event.target.value) / 100;
  $('#host-volume-label').textContent = `${Math.round(volume * 100)}%`;
  event.target.style.setProperty('--fill', `${volume * 100}%`);
  clearTimeout(hostVolumeTimer);
  hostVolumeTimer = setTimeout(() => bridge('/volume', { volume }), 180);
});

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#chat-input'); const message = input.value.trim();
  if (!message) return;
  try { await post('/api/chat', { message }); input.value = ''; hideMentionPicker(); await refreshRoom(); }
  catch (error) { notify(error.message); }
});

$('#gif-bookmark-toggle').addEventListener('click', async () => {
  const picker = $('#gif-bookmark-picker');
  const open = picker.hidden;
  picker.hidden = !open;
  $('#gif-bookmark-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    try { await loadGifBookmarks(); }
    catch (error) { notify(`Could not load bookmarks: ${error.message}`); }
  }
});
$('#gif-picker-close').addEventListener('click', () => {
  $('#gif-bookmark-picker').hidden = true;
  $('#gif-bookmark-toggle').setAttribute('aria-expanded', 'false');
});
$('#chat-clear').addEventListener('click', async () => {
  if (!confirm('Clear the visible room chat? The full server-side chat log is retained.')) return;
  const button = $('#chat-clear'); button.disabled = true;
  try { await request('/api/chat', { method: 'DELETE' }); await refreshRoom(); notify('Visible room chat cleared'); }
  catch (error) { notify(`Could not clear chat: ${error.message}`); }
  finally { button.disabled = false; }
});

$('#control-mode').addEventListener('click', async () => {
  if (!me?.is_admin) return;
  const mode = room?.control_mode === 'shared' ? 'controller' : 'shared';
  try { await post('/api/control/mode', { mode }); await refreshRoom(); notify(mode === 'shared' ? 'Everyone can control playback' : 'Controller handoff is on'); }
  catch (error) { notify(error.message); }
});

$('#people-chat-toggle').addEventListener('click', () => {
  setRoomSidebarCollapsed(!$('.workspace').classList.contains('sidebar-hidden'));
});

async function refreshPlaybackPreferences() {
  if (!me?.is_admin) return;
  try {
    const preferences = await request('/api/bridge/preferences');
    hiddenPlaybackPreferences = {
      default_screen: preferences.default_screen ?? null,
      cookies_browser: preferences.cookies_browser || 'auto',
      cookies_profile: preferences.cookies_profile || null,
    };
    $('#pref-quality').value = ROOM_QUALITIES.has(preferences.default_quality) ? preferences.default_quality : '720';
    $('#pref-codec').value = ['h264', 'vp9', 'auto'].includes(preferences.default_video_codec) ? preferences.default_video_codec : 'h264';
    $('#pref-language').value = preferences.preferred_language ?? '';
    $('#pref-subtitles').checked = Boolean(preferences.subtitles);
  } catch (error) { notify(`Could not read MediaBridge settings: ${error.message}`); }
}

$('#account-signin-tools').addEventListener('toggle', (event) => {
  if (event.target.open) void refreshPlaybackPreferences();
});

async function refreshPairStatus() {
  if (!me?.is_admin) return;
  try {
    const status = await request('/api/bridge/sunshine/pair/status');
    $('#pair-status').textContent = `Pairing status: ${status.status || 'unknown'}${status.message ? ` · ${status.message}` : ''}${status.error ? ` · ${status.error}` : ''}`;
  } catch (error) { $('#pair-status').textContent = `Pairing status unavailable · ${error.message}`; }
}

$('#preferences-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const quality = $('#pref-quality').value;
  try {
    await post('/api/bridge/settings/preferences', {
      default_screen: hiddenPlaybackPreferences.default_screen,
      default_quality: quality === '' ? null : quality,
      default_video_codec: $('#pref-codec').value,
      subtitles: $('#pref-subtitles').checked,
      preferred_language: $('#pref-language').value.trim() || null,
      cookies_browser: hiddenPlaybackPreferences.cookies_browser,
      cookies_profile: hiddenPlaybackPreferences.cookies_profile,
    });
    notify('MediaBridge preferences saved');
  } catch (error) { notify(error.message); }
});

$('#cookie-check').addEventListener('click', async () => {
  try {
    const result = await post('/api/bridge/settings/cookies/check', { cookies_browser: hiddenPlaybackPreferences.cookies_browser, cookies_profile: hiddenPlaybackPreferences.cookies_profile, site: $('#cookie-site').value });
    notify(result.message || result.account_name || 'Cookie access check completed');
  } catch (error) { notify(error.message); }
});

$('#cookie-login').addEventListener('click', async () => {
  const site = $('#cookie-site').value;
  const label = site === 'youtube' ? 'YouTube' : 'Twitch';
  if (!confirm(`This will stop current playback and open the persistent LibreWolf profile in the shared desktop for ${label} sign-in. After signing in, close LibreWolf in the desktop and check local cookies. Continue?`)) return;
  notify(`Requesting ${label} sign-in in the shared desktop…`);
  try {
    const result = await post('/api/bridge/settings/accounts/login', { site });
    // LibreWolf opens inside Neko's virtual display. Reveal the embedded
    // desktop immediately so the user can complete sign-in there.
    setDesktopOpen(true);
    notify(result.message || `${label} sign-in opened in the shared desktop`);
  } catch (error) { notify(error.message); }
});

async function refreshWallpapers() {
  try {
    const data = await request('/api/wallpaper');
    $('#wallpaper-note').textContent = data.desktop_ready ? 'Choose a background for the emulated desktop.' : 'Uploads are saved in room storage. They will apply when the virtual desktop is added.';
    const list = $('#wallpaper-list'); list.replaceChildren();
    for (const wallpaper of data.wallpapers) {
      const row = document.createElement('div'); row.className = 'wallpaper-item';
      const image = document.createElement('img'); image.src = wallpaper.url; image.alt = '';
      const name = document.createElement('span'); name.textContent = wallpaper.name;
      row.append(image, name);
      if (data.selected_id === wallpaper.id) { const selected = document.createElement('span'); selected.className = 'wallpaper-selected'; selected.textContent = 'ACTIVE'; row.append(selected); }
      else { const select = document.createElement('button'); select.className = 'button subtle'; select.textContent = 'Set'; select.addEventListener('click', async () => {
        try { const result = await post('/api/wallpaper/select', { id: wallpaper.id }); await refreshWallpapers(); notify(result.applied ? 'Desktop background changed' : `Saved; ${result.reason}`); }
        catch (error) { notify(error.message); }
      }); row.append(select); }
      if (me?.is_admin) { const remove = document.createElement('button'); remove.className = 'mini-action'; remove.textContent = '×'; remove.title = 'Remove saved image'; remove.addEventListener('click', async () => {
        try { await request(`/api/wallpaper/${wallpaper.id}`, { method: 'DELETE' }); await refreshWallpapers(); notify('Background removed'); }
        catch (error) { notify(error.message); }
      }); row.append(remove); }
      list.append(row);
    }
  } catch (error) { console.warn('Wallpaper list:', error.message); }
}

$('#wallpaper-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) { notify('Choose a PNG, JPEG, or WebP image up to 8 MB'); event.target.value = ''; return; }
  try {
    const image_data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('browser could not read the selected file'));
      reader.readAsDataURL(file);
    });
    await post('/api/wallpaper/upload', { name: file.name.replace(/\.[^.]+$/, ''), image_data_url });
    event.target.value = ''; await refreshWallpapers(); notify('Background image uploaded. Select it to use it.');
  } catch (error) { notify(`Could not upload image: ${error.message}`); }
});

async function uploadBranding(kind, file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
    notify('Choose a PNG, JPEG, or WebP image up to 2 MB');
    return;
  }
  try {
    const image_data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('browser could not read the selected file'));
      reader.readAsDataURL(file);
    });
    await post(`/api/branding/${kind}`, { image_data_url });
    await refreshBranding();
    notify(kind === 'logo' ? 'Website logo updated' : 'Favicon updated');
  } catch (error) { notify(`Could not update branding: ${error.message}`); }
}

for (const kind of ['logo', 'favicon']) {
  $(`#brand-${kind}-file`).addEventListener('change', async (event) => {
    await uploadBranding(kind, event.target.files[0]);
    event.target.value = '';
  });
  $(`#brand-${kind}-clear`).addEventListener('click', async () => {
    try {
      await request(`/api/branding/${kind}`, { method: 'DELETE' });
      await refreshBranding();
      notify(kind === 'logo' ? 'Default logo restored' : 'Default favicon restored');
    } catch (error) { notify(error.message); }
  });
}

async function refreshWebsiteIdentity() {
  try {
    const branding = await request('/api/branding');
    $('#site-server-name').value = branding.server_name || '';
    $('#site-page-title').value = branding.page_title || '';
  } catch (error) { notify(`Could not load site identity: ${error.message}`); }
}

async function refreshChatNotificationSound() {
  const data = await request('/api/admin/chat-notification-sound');
  const audio = $('#chat-notification-preview');
  const clearButton = $('#chat-notification-clear');
  clearButton.hidden = !data.sound_url;
  audio.hidden = !data.sound_url;
  if (data.sound_url) {
    if (audio.getAttribute('src') !== data.sound_url) { audio.src = data.sound_url; audio.load(); }
    $('#chat-notification-status').textContent = 'A room notification sound is uploaded. Members can choose it in their profile.';
  } else {
    audio.pause(); audio.removeAttribute('src'); audio.load();
    $('#chat-notification-status').textContent = 'No notification sound uploaded.';
  }
}

$('#personalize-tools').addEventListener('toggle', async (event) => {
  if (!event.target.open || !me?.is_admin) return;
  try { await Promise.all([refreshChatNotificationSound(), refreshWebsiteIdentity(), refreshWallpapers()]); }
  catch (error) { $('#chat-notification-status').textContent = `Could not load notification sound: ${error.message}`; }
});

$('#chat-notification-file').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  if (!/\.mp3$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
    notify('Choose an MP3 file no larger than 5 MB'); input.value = ''; return;
  }
  input.disabled = true;
  $('#chat-notification-status').textContent = 'Uploading notification sound…';
  try {
    const buffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('browser could not read the MP3 file'));
      reader.readAsArrayBuffer(file);
    });
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    const audio_data_url = `data:audio/mpeg;base64,${btoa(chunks.join(''))}`;
    await post('/api/admin/chat-notification-sound', { audio_data_url });
    await refreshChatNotificationSound();
    await refreshRoom();
    notify('Chat notification sound uploaded');
  } catch (error) {
    $('#chat-notification-status').textContent = `Upload failed: ${error.message}`;
    notify(`Could not upload notification sound: ${error.message}`);
  } finally { input.disabled = false; input.value = ''; }
});

$('#chat-notification-clear').addEventListener('click', async () => {
  if (!confirm('Remove the room chat notification sound?')) return;
  try {
    await request('/api/admin/chat-notification-sound', { method: 'DELETE' });
    await refreshChatNotificationSound();
    await refreshRoom();
    notify('Chat notification sound removed');
  } catch (error) { notify(`Could not remove notification sound: ${error.message}`); }
});

$('#website-identity-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await post('/api/admin/website', { server_name: $('#site-server-name').value.trim(), page_title: $('#site-page-title').value.trim() });
    await refreshBranding();
    await refreshRoom();
    notify('Site name and page title saved');
  } catch (error) { notify(error.message); }
});

$('#remote-access-tools').addEventListener('toggle', async (event) => {
  if (!event.target.open || !me?.is_admin) return;
  try {
    const settings = await request('/api/admin/remote-access');
    $('#remote-public-hostname').value = settings.publicHostname || '';
    $('#remote-trust-proxy').checked = Boolean(settings.trustProxy);
    $('#remote-rtc-address').value = settings.rtcAddress || '';
    $('#remote-port-range').value = `${settings.portStart}-${settings.portEnd}`;
    $('#remote-ice-urls').value = settings.iceUrls || '';
    $('#remote-ice-username').value = settings.iceUsername || '';
    $('#remote-ice-credential').value = '';
    $('#remote-ice-credential').placeholder = settings.hasIceCredential ? 'Saved; leave blank to keep' : '';
  } catch (error) { notify(`Could not load remote access settings: ${error.message}`); }
});

$('#remote-access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await post('/api/admin/remote-access', {
      public_hostname: $('#remote-public-hostname').value.trim(),
      trust_proxy: $('#remote-trust-proxy').checked,
      rtc_address: $('#remote-rtc-address').value.trim(),
      port_range: $('#remote-port-range').value.trim(),
      ice_urls: $('#remote-ice-urls').value,
      ice_username: $('#remote-ice-username').value.trim(),
      ice_credential: $('#remote-ice-credential').value,
    });
    notify(room?.streaming_backend === 'neko' ? 'Remote access settings saved; Neko restarted' : 'Remote access settings saved for Neko');
  } catch (error) { notify(error.message); }
});

$('#streaming-backend-tools').addEventListener('toggle', async (event) => {
  if (!event.target.open || !me?.is_admin) return;
  void refreshPlaybackPreferences();
  try {
    const [settings, buffer, streamResolution, streamBitrate] = await Promise.all([request('/api/admin/streaming-backend'), request('/api/stream-buffer'), request('/api/admin/stream-output-resolution'), request('/api/admin/stream-bitrate')]);
    $('#streaming-backend').value = settings.selected;
    $('#streaming-backend-status').textContent = `Currently running: ${settings.active}. Saved choice: ${settings.selected}. Restart the container to apply a change.`;
    $('#stream-buffer-seconds').value = String(buffer.seconds);
    $('#stream-output-resolution').value = streamResolution.resolution;
    $('#stream-bitrate-kbps').value = String(streamBitrate.bitrate_kbps);
  } catch (error) { notify(`Could not load streaming settings: ${error.message}`); }
});

$('#streaming-backend-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const settings = await post('/api/admin/streaming-backend', { backend: $('#streaming-backend').value });
    $('#streaming-backend-status').textContent = `Saved choice: ${settings.selected}. Currently running: ${settings.active}. Restart the container to apply it.`;
    notify('Streaming backend saved; restart the container to apply it');
  } catch (error) { notify(error.message); }
});

$('#stream-buffer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const settings = await post('/api/admin/stream-buffer', { seconds: Number($('#stream-buffer-seconds').value) });
    notify(`Shared stream buffer set to ${settings.seconds} seconds; everyone must reload to apply it`);
  } catch (error) { notify(error.message); }
});

$('#stream-output-resolution-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const settings = await post('/api/admin/stream-output-resolution', { resolution: $('#stream-output-resolution').value });
    notify(`Outgoing stream resolution saved (${settings.resolution}); reconnect the desktop stream to apply`);
  } catch (error) { notify(error.message); }
});

$('#stream-bitrate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const settings = await post('/api/admin/stream-bitrate', { bitrate_kbps: Number($('#stream-bitrate-kbps').value) });
    notify(settings.applied ? `Room stream target set to ${settings.bitrate_kbps} kbps; Neko restarted` : `Room stream target set to ${settings.bitrate_kbps} kbps; reconnect the desktop stream to apply`);
  } catch (error) { notify(error.message); }
});

async function refreshInvites() {
  if (!me?.is_admin) return;
  try {
    const { invites } = await request('/api/admin/invites');
    const list = $('#invite-list'); list.replaceChildren();
    if (!invites.length) { const empty = document.createElement('p'); empty.className = 'muted tiny-copy'; empty.textContent = 'No active invite codes.'; list.append(empty); return; }
    for (const invite of invites) {
      const row = document.createElement('div'); row.className = 'invite-row';
      const label = document.createElement('span'); label.textContent = `Unused ${invite.role === 'guest' ? 'guest' : 'user'} invite · created ${new Date(invite.created_at).toLocaleDateString()}`;
      const revoke = document.createElement('button'); revoke.className = 'mini-action'; revoke.type = 'button'; revoke.title = 'Revoke invite'; revoke.textContent = '×';
      revoke.addEventListener('click', async () => { try { await request(`/api/admin/invites/${invite.id}`, { method: 'DELETE' }); await refreshInvites(); } catch (error) { notify(error.message); } });
      row.append(label, revoke); list.append(row);
    }
  } catch (error) { notify(`Could not load invites: ${error.message}`); }
}

async function refreshAdminMembers() {
  if (!me?.is_admin) return;
  try {
    const { users } = await request('/api/admin/members');
    const list = $('#admin-member-list'); list.replaceChildren();
    for (const user of users) {
      const row = document.createElement('div'); row.className = 'admin-member-row';
      const identity = document.createElement('div'); identity.className = 'admin-member-identity';
      const name = document.createElement('strong'); name.textContent = user.nickname;
      const username = document.createElement('span'); username.className = 'muted'; username.textContent = `@${user.username}`;
      identity.append(name, username);
      const role = document.createElement('select'); role.setAttribute('aria-label', `Role for ${user.nickname}`);
      for (const [value, label] of [['guest', 'Guest · watch only'], ['user', 'User · full control'], ['moderator', 'Moderator · room moderation'], ['admin', 'Admin · full access']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; role.append(option); }
      role.value = user.is_admin ? 'admin' : user.is_moderator ? 'moderator' : user.is_guest ? 'guest' : 'user';
      role.disabled = user.is_admin;
      if (user.is_admin) role.title = 'Admin role is protected';
      else role.addEventListener('change', async () => {
        role.disabled = true;
        try {
          await request(`/api/admin/members/${encodeURIComponent(user.id)}/role`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: role.value }) });
          await Promise.all([refreshAdminMembers(), refreshRoom()]);
          notify(`${user.nickname} is now a ${role.value}`);
        } catch (error) { role.value = user.is_moderator ? 'moderator' : user.is_guest ? 'guest' : 'user'; role.disabled = false; notify(`Could not update role: ${error.message}`); }
      });
      row.append(identity, role); list.append(row);
    }
    if (!users.length) { const empty = document.createElement('p'); empty.className = 'muted tiny-copy'; empty.textContent = 'No accounts yet.'; list.append(empty); }
  } catch (error) { notify(`Could not load accounts: ${error.message}`); }
}

$('#invite-create').addEventListener('click', async () => {
  try {
    const role = $('#invite-role').value;
    const { invite } = await post('/api/admin/invites', { role });
    const list = $('#invite-list');
    const codeRow = document.createElement('div'); codeRow.className = 'invite-code-row';
    const code = document.createElement('code'); code.textContent = invite.code;
    const copy = document.createElement('button'); copy.className = 'button subtle'; copy.type = 'button'; copy.textContent = 'Copy';
    copy.addEventListener('click', async () => { try { await copyTextToClipboard(invite.code); notify('Invite code copied'); } catch { notify(`Could not copy. Invite code: ${invite.code}`); } });
    codeRow.append(code, copy); list.prepend(codeRow); await refreshInvites();
    // Keep the newly issued code visible; the server only stores its one-way use state.
    list.prepend(codeRow);
    notify(`One-use ${role} invite created. Copy it now; it cannot be shown again.`);
  } catch (error) { notify(`Could not create invite: ${error.message}`); }
});

$('#admin-open').addEventListener('click', () => {
  $('#admin-dialog').showModal();
  void refreshInvites();
  void refreshAdminMembers();
  void refreshAdminLogs();
  void refreshStatus();
  if ($('#host-integration-tools').open) void refreshPairStatus();
});

async function refreshAdminLogs() {
  if (!me?.is_admin) return;
  const list = $('#admin-log-list');
  list.replaceChildren();
  const loading = document.createElement('span'); loading.className = 'muted tiny-copy'; loading.textContent = 'Loading available logs…'; list.append(loading);
  try {
    const data = await request('/api/admin/logs');
    list.replaceChildren();
    if (!data.files?.length) {
      const empty = document.createElement('span'); empty.className = 'muted tiny-copy'; empty.textContent = 'No history files have been created yet.'; list.append(empty); return;
    }
    for (const file of data.files) {
      const row = document.createElement('div'); row.className = 'admin-log-row';
      const label = document.createElement('span'); label.textContent = `${file.label} · ${formatLogSize(file.size_bytes)}`;
      const link = document.createElement('a'); link.className = 'button subtle'; link.href = file.download_url; link.download = file.filename; link.textContent = 'Download';
      row.append(label, link); list.append(row);
    }
  } catch (error) {
    list.replaceChildren();
    const failed = document.createElement('span'); failed.className = 'muted tiny-copy'; failed.textContent = `Could not list history files: ${error.message}`; list.append(failed);
  }
}

function formatLogSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

$('#admin-log-refresh').addEventListener('click', () => { void refreshAdminLogs(); });

$('#profile-open').addEventListener('click', () => { populateProfileDialog(); $('#profile-dialog').showModal(); });
$('#chat-notification-mode').addEventListener('change', (event) => {
  try { localStorage.setItem(CHAT_NOTIFICATION_MODE_KEY, event.currentTarget.value); }
  catch { notify('This browser could not save the chat notification preference'); }
  if (event.currentTarget.value === 'sound' && !room?.chat_notification_sound_url) notify('The admin has not uploaded a notification sound yet');
});
$('#chat-notification-scope').addEventListener('change', (event) => {
  try { localStorage.setItem(CHAT_NOTIFICATION_SCOPE_KEY, event.currentTarget.value); }
  catch { notify('This browser could not save the chat notification preference'); }
});
$('#profile-image').addEventListener('change', async (event) => {
  selectedAvatarData = null;
  const file = event.target.files[0];
  if (!file) return;
  const extension = file.name.split('.').pop().toLowerCase();
  const knownMime = ['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp'].includes(file.type);
  const knownExtension = ['png', 'jpg', 'jpeg', 'webp'].includes(extension);
  if ((!knownMime && !(knownExtension && !file.type)) || file.size > 2 * 1024 * 1024) {
    const message = 'Choose a PNG, JPEG, or WebP image no larger than 2 MB.';
    $('#profile-image-status').textContent = message;
    notify(message);
    return;
  }
  selectedAvatarProcessing = true;
  const saveButton = $('#profile-form button[type="submit"]');
  saveButton.disabled = true;
  saveButton.textContent = 'Preparing picture…';
  $('#profile-image-status').textContent = 'Preparing picture…';
  try {
    selectedAvatarData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('browser could not read the selected file'));
      reader.readAsDataURL(file);
    });
    if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(selectedAvatarData)) throw new Error('browser returned an unsupported image format');
    if (Math.floor((selectedAvatarData.split(',')[1]?.length || 0) * 3 / 4) > 2 * 1024 * 1024) throw new Error('processed picture is still too large; choose another image');
    const preview = document.createElement('img'); preview.src = selectedAvatarData; preview.alt = '';
    $('#profile-preview-avatar').replaceChildren(preview);
    $('#profile-image-status').textContent = 'Picture ready. Click Save profile to upload it.';
  } catch (error) {
    selectedAvatarData = null;
    const message = `Could not prepare profile picture: ${error.message || 'image decoding failed'}`;
    $('#profile-image-status').textContent = message;
    notify(message);
  } finally {
    selectedAvatarProcessing = false;
    saveButton.textContent = 'Save profile';
    saveButton.disabled = false;
  }
});

$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (selectedAvatarProcessing) return notify('Wait for the profile picture to finish processing');
    const pictureNotReady = $('#profile-image').files.length > 0 && !selectedAvatarData;
    const uploadingAvatar = Boolean(selectedAvatarData);
    const result = await post('/api/profile', { nickname: $('#profile-nickname').value, ...(selectedAvatarData ? { avatar_data_url: selectedAvatarData } : {}) });
    if (uploadingAvatar && !result.user?.avatar) throw new Error('The server did not confirm saving the profile picture');
    if (uploadingAvatar) $('#profile-image-status').textContent = 'Picture saved.';
    me = result.user; selectedAvatarData = null; $('#profile-image').value = ''; updateMyProfile();
    if (desktopIsOpen && room?.streaming_backend !== 'go2rtc') {
      $('#desktop-frame').src = `/neko/?embed=1&usr=${encodeURIComponent(me.nickname)}&pwd=room-session&volume=${localAudioVolume}&autounmute=1`;
    }
    $('#profile-dialog').close(); await refreshRoom(); notify(pictureNotReady ? 'Nickname saved; picture was not uploaded. Choose it again to retry.' : uploadingAvatar ? 'Profile and picture saved' : 'Profile saved');
  } catch (error) {
    if ($('#profile-image').files.length) $('#profile-image-status').textContent = `Picture upload failed: ${error.message}`;
    notify(error.message);
  }
});

$('#sign-out').addEventListener('click', async () => {
  await post('/api/auth/logout').catch(() => {});
  setDesktopOpen(false);
  $('#profile-dialog').close();
  me = null; room = null; playback = null; roomView.hidden = true; authView.hidden = false; setAuthMode(false);
});

let lastDesktopInputErrorAt = 0;
let desktopTap = null;
const DESKTOP_KEYBOARD_PREFERENCE = 'baka-inu-desktop-keyboard-visible';
let desktopKeyboardVisible = false;
try { desktopKeyboardVisible = localStorage.getItem(DESKTOP_KEYBOARD_PREFERENCE) === 'true'; } catch {}
let desktopIsOpen = false;
let desktopFrameResizeObserver = null;
const playerLayoutDebug = new URLSearchParams(location.search).get('debugPlayer') === '1';

function fitDesktopVideoFrame() {
  const stage = $('#player-stage');
  const viewport = $('#desktop-viewport');
  const player = $('#desktop-video');
  if (!stage || !viewport || !player || player.hidden) return;
  const stageRect = stage.getBoundingClientRect();
  const { width: stageWidth, height: stageHeight } = stageRect;
  if (!stageWidth || !stageHeight) return;
  const video = player.video;
  if (!video) return;
  const aspect = video?.videoWidth && video?.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  let width = stageWidth;
  let height = width / aspect;
  if (height > stageHeight) { height = stageHeight; width = height * aspect; }
  const left = Math.floor((stageWidth - width) / 2);
  const top = Math.floor((stageHeight - height) / 2);
  Object.assign(viewport.style, {
    position: 'absolute', inset: '0', display: 'block',
    width: `${Math.floor(stageWidth)}px`, height: `${Math.floor(stageHeight)}px`,
  });
  Object.assign(player.style, {
    position: 'absolute', inset: '0', left: '0', top: '0',
    width: `${Math.floor(stageWidth)}px`, height: `${Math.floor(stageHeight)}px`,
    margin: '0', transform: 'none',
  });
  Object.assign(video.style, {
    display: 'block', position: 'absolute', inset: 'auto',
    left: `${left}px`, top: `${top}px`,
    width: `${Math.floor(width)}px`, height: `${Math.floor(height)}px`,
    maxWidth: 'none', maxHeight: 'none', margin: '0',
    objectFit: 'fill', objectPosition: 'center center',
    transform: 'none',
  });
  if (playerLayoutDebug) {
    const hostRect = player.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();
    const round = (value) => Math.round(value);
    const debug = $('#player-layout-debug');
    debug.hidden = false;
    debug.textContent = [
      `backend ${room?.streaming_backend || 'unknown'}`,
      `card ${round(stage.parentElement.getBoundingClientRect().width)}×${round(stage.parentElement.getBoundingClientRect().height)}`,
      `stage ${round(stageWidth)}×${round(stageHeight)}`,
      `host ${round(hostRect.left - stageRect.left)},${round(hostRect.top - stageRect.top)} ${round(hostRect.width)}×${round(hostRect.height)}`,
      `video ${round(videoRect.left - stageRect.left)},${round(videoRect.top - stageRect.top)} ${round(videoRect.width)}×${round(videoRect.height)}`,
      `fit ${getComputedStyle(video).objectFit}`,
    ].join(' · ');
  }
}

async function setDesktopOpen(open) {
  const frame = $('#desktop-frame');
  const player = $('#desktop-video');
  if (!open) {
    desktopIsOpen = false;
    $('#stream-stats').hidden = true;
    frame.hidden = true;
    frame.src = 'about:blank';
    player.hidden = true;
    if (customElements.get('baka-desktop-video')) {
      player.video.pause();
      if (player.reconnectTID) clearTimeout(player.reconnectTID);
      player.reconnectTID = 0;
      player.ondisconnect();
      player.wsURL = '';
    }
    $('#desktop-text-form').hidden = true;
    $('#keyboard-toggle').setAttribute('aria-pressed', 'false');
    $('#keyboard-toggle').setAttribute('aria-label', 'Show desktop keyboard controls');
    $('#keyboard-toggle').title = 'Show desktop keyboard controls';
    $('#desktop-overlay-toggle').hidden = true;
    $('#player-stage').classList.remove('desktop-active');
    return;
  }
  if (!room?.desktop_available) return notify('Desktop streaming is unavailable');
  if (desktopIsOpen) return;
  desktopIsOpen = true;
  $('#player-stage').classList.add('desktop-active');
  if (room.streaming_backend === 'go2rtc') {
    frame.hidden = true;
    $('#stream-stats').hidden = false;
    $('#keyboard-toggle').hidden = false;
    await ensureGo2rtcPlayer();
    player.hidden = false;
    if (!desktopFrameResizeObserver) {
      desktopFrameResizeObserver = new ResizeObserver(fitDesktopVideoFrame);
      desktopFrameResizeObserver.observe($('#player-stage'));
      player.video.addEventListener('loadedmetadata', fitDesktopVideoFrame);
      player.video.addEventListener('resize', fitDesktopVideoFrame);
    }
    requestAnimationFrame(fitDesktopVideoFrame);
    player.video.volume = localAudioVolume;
    player.video.muted = false;
    $('#desktop-text-form').hidden = !desktopKeyboardVisible;
    $('#keyboard-toggle').setAttribute('aria-pressed', String(desktopKeyboardVisible));
    $('#keyboard-toggle').setAttribute('aria-label', desktopKeyboardVisible ? 'Hide desktop keyboard controls' : 'Show desktop keyboard controls');
    $('#keyboard-toggle').title = desktopKeyboardVisible ? 'Hide desktop keyboard controls' : 'Show desktop keyboard controls';
    $('#desktop-overlay-toggle').hidden = true;
    connectDesktopStream();
  } else {
    player.hidden = true;
    $('#stream-stats').hidden = true;
    $('#desktop-text-form').hidden = true;
    $('#keyboard-toggle').hidden = true;
    $('#desktop-overlay-toggle').hidden = false;
    frame.src = `/neko/?embed=1&usr=${encodeURIComponent(me.nickname)}&pwd=room-session&volume=${localAudioVolume}&autounmute=1`;
    frame.hidden = false;
  }
}

$('#player-resync').addEventListener('click', async () => {
  if (!room?.desktop_available) return notify('Desktop streaming is unavailable');
  const button = $('#player-resync');
  button.disabled = true;
  try {
    await setDesktopOpen(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await setDesktopOpen(true);
    notify('Player stream reconnected');
  } catch (error) { notify(`Could not reconnect player: ${error.message}`); }
  finally { button.disabled = false; }
});

function updateFullscreenButton() {
  const active = document.fullscreenElement === $('#player-stage');
  const button = $('#player-fullscreen');
  button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  button.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
  button.classList.toggle('is-active', active);
}

$('#player-fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('#player-stage').requestFullscreen();
  } catch (error) { notify(`Fullscreen is unavailable: ${error.message}`); }
});
document.addEventListener('fullscreenchange', updateFullscreenButton);

function connectDesktopStream() {
  const player = $('#desktop-video');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  player.mode = 'mse';
  player.media = 'video,audio';
  player.src = `${protocol}//${location.host}/stream/api/ws?src=desktop`;
}

function applyLocalDesktopVolume() {
  if (room?.streaming_backend !== 'go2rtc') {
    try {
      const video = $('#desktop-frame').contentDocument?.querySelector('video');
      if (video) {
        video.volume = localAudioVolume;
        video.muted = localAudioVolume === 0;
        if (!video.muted && video.paused) video.play().catch(() => {});
      }
    } catch {}
    return;
  }
  if (!customElements.get('baka-desktop-video')) return;
  const video = $('#desktop-video').video;
  video.volume = localAudioVolume;
  video.muted = false;
  if (!$("#desktop-video").hidden && video.paused) video.play().catch(() => {});
}

$('#desktop-frame').addEventListener('load', () => {
  if (!desktopIsOpen || room?.streaming_backend === 'go2rtc') return;
  let observer;
  const applyVolume = () => {
    try {
      const video = $('#desktop-frame').contentDocument?.querySelector('video');
      if (video) {
        video.volume = localAudioVolume;
        video.muted = localAudioVolume === 0;
      }
    } catch {}
  };
  try {
    const doc = $('#desktop-frame').contentDocument;
    if (doc?.documentElement) {
      observer = new MutationObserver(applyVolume);
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      applyVolume();
      setTimeout(() => observer.disconnect(), 30000);
    }
  } catch {}
});

$('#desktop-overlay-toggle').addEventListener('click', () => {
  if (!desktopIsOpen || room?.streaming_backend === 'go2rtc') return;
  const hide = $('#desktop-overlay-toggle').getAttribute('aria-pressed') !== 'true';
  $('#desktop-overlay-toggle').setAttribute('aria-pressed', String(hide));
  $('#desktop-overlay-toggle').setAttribute('aria-label', hide ? 'Show desktop controls' : 'Hide desktop controls');
  $('#desktop-overlay-toggle').title = hide ? 'Show desktop controls' : 'Hide desktop controls';
  $('#desktop-frame').src = `/neko/?${hide ? 'cast=1' : 'embed=1'}&usr=${encodeURIComponent(me.nickname)}&pwd=room-session&volume=${localAudioVolume}&autounmute=1`;
});

function resumeDesktopPlayback() {
  unlockDesktopAudio();
}

function unlockDesktopAudio() {
  if (!customElements.get('baka-desktop-video')) return;
  const video = $('#desktop-video').video;
  if (!video) return;
  video.volume = localAudioVolume;
  video.muted = false;
  video.play().catch(() => {});
}

async function sendDesktopInput(input) {
  try { await post('/api/desktop/input', input); }
  catch (error) {
    console.warn('Desktop input failed:', error.message);
    const now = Date.now();
    if (now - lastDesktopInputErrorAt > 2500) {
      lastDesktopInputErrorAt = now;
      notify(`Desktop input failed: ${error.message}`);
    }
  }
}

function desktopPoint(event) {
  const box = $('#desktop-video').video.getBoundingClientRect();
  const width = $('#desktop-video').video.videoWidth || 1280;
  const height = $('#desktop-video').video.videoHeight || 720;
  const scale = Math.min(box.width / width, box.height / height);
  const drawnWidth = width * scale, drawnHeight = height * scale;
  const left = box.left + (box.width - drawnWidth) / 2, top = box.top + (box.height - drawnHeight) / 2;
  return { x: Math.max(0, Math.min(1, (event.clientX - left) / drawnWidth)), y: Math.max(0, Math.min(1, (event.clientY - top) / drawnHeight)) };
}

$('#desktop-video').addEventListener('pointerdown', (event) => {
  if (!room?.can_control) { event.preventDefault(); notify('You do not currently have desktop control.'); return; }
  resumeDesktopPlayback();
  event.preventDefault(); $('#player-stage').focus({ preventScroll: true });
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  desktopTap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' };
});
$('#desktop-video').addEventListener('pointerup', (event) => {
  if (!desktopTap || desktopTap.pointerId !== event.pointerId) return;
  const tap = desktopTap; desktopTap = null;
  if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) return;
  sendDesktopInput({ type: 'pointer', action: 'click', button: tap.button, ...desktopPoint(event) });
});
$('#desktop-video').addEventListener('pointercancel', () => { desktopTap = null; });
$('#desktop-video').addEventListener('contextmenu', (event) => event.preventDefault());
$('#desktop-video').addEventListener('wheel', (event) => { event.preventDefault(); sendDesktopInput({ type: 'scroll', direction: event.deltaY < 0 ? 'up' : 'down' }); }, { passive: false });

const desktopKeys = { Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', ' ': 'space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down', Shift: 'Shift_L', Control: 'Control_L', Alt: 'Alt_L', Meta: 'Super_L', '!': 'exclam', '@': 'at', '#': 'numbersign', '$': 'dollar', '%': 'percent', '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright', '_': 'underscore', '+': 'plus', '=': 'equal', '-': 'minus', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '`': 'grave', '{': 'braceleft', '}': 'braceright', ':': 'colon', '"': 'quotedbl', '<': 'less', '>': 'greater', '?': 'question', '|': 'bar', '~': 'asciitilde' };
const heldDesktopKeys = new Set();
document.addEventListener('keydown', (event) => {
  if ($('#desktop-video').hidden || !$('#player-stage').contains(document.activeElement) || event.repeat) return;
  const key = desktopKeys[event.key] || (/^[a-zA-Z0-9]$/.test(event.key) ? event.key : (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key : null));
  if (!key) return;
  event.preventDefault();
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) heldDesktopKeys.add(key);
  sendDesktopInput({ type: 'key', action: ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key) ? 'down' : 'press', key });
});
document.addEventListener('keyup', (event) => {
  if ($('#desktop-video').hidden || !$('#player-stage').contains(document.activeElement)) return;
  const key = desktopKeys[event.key];
  if (key && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) { event.preventDefault(); heldDesktopKeys.delete(key); sendDesktopInput({ type: 'key', action: 'up', key }); }
});
function releaseDesktopKeys() {
  for (const key of heldDesktopKeys) sendDesktopInput({ type: 'key', action: 'up', key });
  heldDesktopKeys.clear();
}
document.addEventListener('pointerdown', (event) => {
  if ($('#desktop-video').hidden || $('#player-stage').contains(event.target) || $('#desktop-text-form').contains(event.target)) return;
  $('#player-stage').blur(); releaseDesktopKeys();
}, true);
window.addEventListener('blur', releaseDesktopKeys);
$('#desktop-text-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#desktop-text'); const text = input.value;
  if (!text) return;
  await sendDesktopInput({ type: 'text', text });
  input.value = ''; $('#player-stage').focus({ preventScroll: true });
});

$('#keyboard-toggle').addEventListener('click', () => {
  if ($('#desktop-video').hidden) {
    desktopKeyboardVisible = true;
    try { localStorage.setItem(DESKTOP_KEYBOARD_PREFERENCE, 'true'); } catch {}
    setDesktopOpen(true);
    if (!$('#desktop-video').hidden) $('#desktop-text').focus({ preventScroll: true });
    return;
  }
  desktopKeyboardVisible = !desktopKeyboardVisible;
  try { localStorage.setItem(DESKTOP_KEYBOARD_PREFERENCE, String(desktopKeyboardVisible)); } catch {}
  $('#desktop-text-form').hidden = !desktopKeyboardVisible;
  $('#keyboard-toggle').setAttribute('aria-pressed', String(desktopKeyboardVisible));
  $('#keyboard-toggle').setAttribute('aria-label', desktopKeyboardVisible ? 'Hide desktop keyboard controls' : 'Show desktop keyboard controls');
  $('#keyboard-toggle').title = desktopKeyboardVisible ? 'Hide desktop keyboard controls' : 'Show desktop keyboard controls';
  if (desktopKeyboardVisible) $('#desktop-text').focus({ preventScroll: true });
  else $('#player-stage').focus({ preventScroll: true });
});

for (const [selector, key] of [['#desktop-enter', 'Return'], ['#desktop-backspace', 'BackSpace']]) {
  $(selector).addEventListener('click', () => {
    if (!room?.can_control) return notify('You do not currently have desktop control.');
    resumeDesktopPlayback();
    sendDesktopInput({ type: 'key', action: 'press', key });
    $('#desktop-text').focus({ preventScroll: true });
  });
}

$('#stage-content').addEventListener('click', () => setDesktopOpen(true));
$('#stage-content').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setDesktopOpen(true); }
});

// Animate real section height so the centered dialog grows along with its content.
for (const section of $('#admin-dialog').querySelectorAll('details.settings-tools')) {
  const summary = section.querySelector(':scope > summary');
  const body = section.querySelector(':scope > .settings-body');
  if (!summary || !body) continue;
  const state = { expanded: section.open, animation: null, target: 0 };
  const measuredHeight = (expand) => {
    const style = getComputedStyle(section);
    const frame = ['borderTopWidth', 'borderBottomWidth', 'paddingTop', 'paddingBottom'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
    const summaryHeight = summary.getBoundingClientRect().height;
    return frame + summaryHeight + (expand ? body.getBoundingClientRect().height : -(parseFloat(getComputedStyle(summary).borderBottomWidth) || 0));
  };
  const animateSection = (expand, from = section.getBoundingClientRect().height) => {
    state.animation?.cancel();
    state.animation = null;
    state.expanded = expand;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !section.animate) {
      section.open = expand;
      section.style.overflow = '';
      return;
    }
    section.open = true;
    const target = measuredHeight(expand);
    state.target = target;
    section.style.overflow = 'hidden';
    const animation = section.animate([{ height: `${from}px` }, { height: `${target}px` }], {
      duration: 230, easing: 'cubic-bezier(.2,.7,.25,1)',
    });
    state.animation = animation;
    animation.finished.then(() => {
      if (state.animation !== animation) return;
      section.open = expand;
      section.style.overflow = '';
      state.animation = null;
    }).catch(() => {});
  };
  summary.addEventListener('click', (event) => {
    event.preventDefault();
    animateSection(state.animation ? !state.expanded : !section.open);
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
    if (!section.open || !state.expanded || !$('#admin-dialog').open) return;
    const current = section.getBoundingClientRect().height;
    const natural = measuredHeight(true);
    if (state.target && Math.abs(natural - state.target) > 1) animateSection(true, state.animation ? current : state.target);
  }).observe(body);
}

initSmbBrowser({ request, post, bridge, notify, getUser: () => me });

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    // Child controls can resize the dialog before this click bubbles up
    // (pagination clears its list). Only backdrop clicks may dismiss it.
    if (!dialog.open || event.composedPath()[0] !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}

setInterval(() => { if (!roomView.hidden) { refreshStatus(); refreshRoom(); if ($('#admin-dialog').open) { void refreshAdminHardware(); if ($('#host-integration-tools').open) refreshPairStatus(); } } }, 3000);
setInterval(() => { refreshBranding().catch(() => {}); }, 15000);

refreshBranding().catch((error) => console.warn('Website branding:', error.message));
enterRoom().catch((error) => { console.error(error); authView.hidden = false; roomView.hidden = true; $('#auth-error').textContent = error.message; });
