import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { smbMediaSession } from './smb-stream.mjs';

const sessionCredentials = new Map();
function secretFile(dataDir, name, bytes) {
  const file = path.join(dataDir, name);
  try { fs.writeFileSync(file, crypto.randomBytes(bytes).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return fs.readFileSync(file, 'utf8').trim();
}
export function smbCredentials(share, dataDir) {
  if (sessionCredentials.has(share.id)) return sessionCredentials.get(share.id);
  if (!share.credentials) return null;
  const key = Buffer.from(fs.readFileSync(path.join(dataDir, 'smb-credentials.key'), 'utf8').trim(), 'hex');
  const { iv, tag, ciphertext } = share.credentials;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(share.id)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
export function storeSmbCredentials(share, body, dataDir) {
  let username = String(body.username || '').trim(), domain = String(body.domain || '').trim();
  if (username.includes('\\') && !domain) [domain, username] = [username.slice(0, username.indexOf('\\')), username.slice(username.indexOf('\\') + 1)];
  const password = String(body.password ?? '');
  if (!username || username.length > 256 || domain.length > 256 || password.length > 1024 || /[\r\n\0]/.test(username + domain + password)) throw new Error('Enter a valid username, password, and optional domain (no line breaks)');
  const credentials = { username, password, domain };
  secretFile(dataDir, 'smb-playback.token', 32);
  if (body.remember === false) { sessionCredentials.set(share.id, credentials); delete share.credentials; return; }
  sessionCredentials.delete(share.id);
  const key = Buffer.from(secretFile(dataDir, 'smb-credentials.key', 32), 'hex'), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(share.id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  share.credentials = { username, domain, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function forgetSmbCredentials(share) { sessionCredentials.delete(share.id); delete share.credentials; }
export function publicSmbShare(share) {
  const session = sessionCredentials.get(share.id);
  return { id: share.id, name: share.name, url: share.url, has_credentials: Boolean(session || share.credentials), username: session?.username || share.credentials?.username || '', domain: session?.domain || share.credentials?.domain || '' };
}
export function smbUrlInShare(value, root) {
  try {
    const url = new URL(value), base = new URL(root);
    const pathname = decodeURIComponent(url.pathname).replace(/\/$/, ''), basePath = decodeURIComponent(base.pathname).replace(/\/$/, '');
    if (url.protocol !== 'smb:' || url.username || url.password || url.search || url.hash || url.host.toLowerCase() !== base.host.toLowerCase()) return false;
    if (/[\\\x00-\x1f]/.test(pathname) || pathname.split('/').some((part) => part === '..' || part === '.')) return false;
    return pathname === basePath || pathname.startsWith(basePath + '/');
  } catch { return false; }
}
export function smbShareForPlayback(dataDir, value) {
  if (!String(value || '').toLowerCase().startsWith('smb://')) return null;
  try {
    const shares = JSON.parse(fs.readFileSync(path.join(dataDir, 'smb-shares.json'), 'utf8'));
    const share = shares.filter((share) => smbUrlInShare(value, share.url)).sort((a, b) => b.url.length - a.url.length)[0];
    if (share) secretFile(dataDir, 'smb-playback.token', 32);
    return share?.id || null;
  } catch { return null; }
}
export function smbPlaybackFile(dataDir, shareId, value) {
  const shares = JSON.parse(fs.readFileSync(path.join(dataDir, 'smb-shares.json'), 'utf8'));
  const share = shares.find((item) => item.id === shareId);
  if (!share || !smbUrlInShare(value, share.url)) throw new Error('SMB file is outside the configured share');
  return { url: value, credentials: smbCredentials(share, dataDir) };
}
export async function handleSmbCredentialRequest({ request, response, url, dataDir, json }) {
  if (url.pathname !== '/api/internal/smb-credentials') return false;
  const peer = request.socket.remoteAddress;
  let token = '';
  try { token = fs.readFileSync(path.join(dataDir, 'smb-playback.token'), 'utf8').trim(); } catch {}
  const provided = String(request.headers.authorization || '').replace(/^Bearer /, '');
  if (request.method !== 'GET' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) || !/^[a-f0-9]{64}$/.test(provided) || !token || provided.length !== token.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
    json(response, 403, { error: 'Private MediaBridge credential endpoint' }); return true;
  }
  try {
    const shareId = url.searchParams.get('share'), value = url.searchParams.get('url');
    const file = smbPlaybackFile(dataDir, shareId, value);
    json(response, 200, { ...(file.credentials || { username: '', password: '', domain: '' }), playback_url: smbMediaSession(shareId, value, request.socket.localPort) });
  } catch { json(response, 403, { error: 'SMB credentials unavailable; sign in through Browse SMB shares' }); }
  return true;
}
