import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import { smbCredentials, storeSmbCredentials, forgetSmbCredentials, publicSmbShare } from './smb-auth.mjs';

const VIDEO = /\.(?:mkv|mp4|m4v|avi|mov|webm|mpeg|mpg|ts|m2ts|mts|wmv|flv|ogv|vob)$/i;
let activeListings = 0;
function segments(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || /[\\\x00-\x1f\x7f]/.test(part))) throw new Error('Invalid folder path');
  return parts;
}
function shareUrl(value) {
  if (String(value || '').length > 2048) throw new Error('Share URL is too long');
  const url = new URL(String(value || ''));
  if (url.protocol !== 'smb:' || !url.hostname || url.username || url.password || url.port || url.search || url.hash
      || !/^[a-z\d.\-_[\]:]+$/i.test(url.hostname)) throw new Error('Use smb://server/share/folder without credentials');
  const parts = segments(decodeURIComponent(url.pathname));
  if (!parts.length) throw new Error('A share name is required');
  url.pathname = '/' + parts.map(encodeURIComponent).join('/');
  return url.href.replace(/\/$/, '');
}
async function listDirectory(share, folder, dataDir) {
  if (activeListings >= 2) throw new Error('Another share is loading. Please try again shortly.');
  const root = new URL(share.url), base = segments(decodeURIComponent(root.pathname)), relative = segments(folder);
  activeListings += 1;
  let authDirectory = null;
  try {
    const credentials = smbCredentials(share, dataDir);
    let authFile = null;
    if (credentials) {
      authDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'baka-smb-auth-')); fs.chmodSync(authDirectory, 0o700);
      authFile = path.join(authDirectory, 'credentials');
      fs.writeFileSync(authFile, `username = ${credentials.username}\npassword = ${credentials.password}\ndomain = ${credentials.domain}\n`, { mode: 0o600 });
    }
    const connect = (username) => new Promise((resolve, reject) => {
      const child = spawn('smbclient', [`//${root.hostname}/${base[0]}`, ...(authFile ? ['-A', authFile] : ['-N', '-U', username]), '-t', '10', '-d', '0', '-D', [...base.slice(1), ...relative].join('\\') || '\\', '-c', 'ls'], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8' },
      });
      let stdout = '', stderr = '', tooLarge = false;
      const decoder = new StringDecoder('utf8');
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.stdout.on('data', (chunk) => { stdout += decoder.write(chunk); if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { tooLarge = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-2048); });
      child.once('error', (error) => { clearTimeout(timer); reject(new Error(error.code === 'ENOENT' ? 'SMB client is not installed; rebuild the container image' : error.message)); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (tooLarge) return reject(new Error('Directory is too large; bookmark a smaller subfolder'));
        if (code !== 0) return reject(new Error((stderr || stdout).trim().slice(-1000) || 'SMB share did not respond within 20 seconds'));
        resolve(stdout + decoder.end());
      });
    });
    let output;
    try { output = await connect('%'); }
    catch (error) {
      if (!/NT_STATUS_(?:LOGON_FAILURE|ACCESS_DENIED|ACCOUNT_DISABLED|NO_SUCH_USER)/.test(error.message)) throw error;
      if (credentials) throw Object.assign(new Error('Windows rejected this account or denied access to the folder. Check the username, password, and share permissions.'), { code: 'SMB_AUTH_REQUIRED' });
      try { output = await connect('guest%'); }
      catch (guestError) {
        if (/NT_STATUS_(?:LOGON_FAILURE|ACCESS_DENIED|ACCOUNT_DISABLED|NO_SUCH_USER)/.test(guestError.message)) {
          throw Object.assign(new Error('This share requires authentication. Sign in with an account on the Windows computer hosting the share.'), { code: 'SMB_AUTH_REQUIRED' });
        }
        throw guestError;
      }
    }
    const entries = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s{2}(.+?)\s{2,}([A-Z]+)\s+(\d+)\s+/.exec(line);
      if (!match) continue;
      const [, name, attributes, size] = match;
      if (name === '.' || name === '..' || /[\/\\\x00-\x1f\x7f]/.test(name)) continue;
      const directory = attributes.includes('D');
      if (!directory && !VIDEO.test(name)) continue;
      const entryPath = [...relative, name].join('/');
      entries.push({ name, directory, size: Number(size), path: entryPath, url: `${share.url}/${entryPath.split('/').map(encodeURIComponent).join('/')}` });
    }
    if (!entries.length && /NT_STATUS_[A-Z_]+/.test(output)) throw new Error(output.trim().slice(-1000));
    return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  } finally {
    if (authDirectory) { try { fs.unlinkSync(path.join(authDirectory, 'credentials')); } catch {} try { fs.rmdirSync(authDirectory); } catch {} }
    activeListings -= 1;
  }
}
export async function handleSmbBrowser({ request, response, url, user, dataDir, readJson, json, fail }) {
  if (!url.pathname.startsWith('/api/admin/smb/')) return false;
  if (!user.isAdmin) { fail(response, 403, 'Only the admin can browse SMB shares'); return true; }
  const file = path.join(dataDir, 'smb-shares.json');
  let shares;
  try { shares = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(shares)) shares = []; } catch { shares = []; }
  try {
    if (url.pathname === '/api/admin/smb/shares' && request.method === 'GET') json(response, 200, { shares: shares.map(publicSmbShare) });
    else if (url.pathname === '/api/admin/smb/shares' && ['POST', 'PUT'].includes(request.method)) {
      const body = await readJson(request, 8192);
      const editing = request.method === 'PUT';
      const index = editing ? shares.findIndex((share) => share.id === body.id) : -1;
      if (editing && index < 0) throw new Error('Share bookmark not found');
      if (!editing && shares.length >= 20) throw new Error('You can bookmark up to 20 shares');
      const normalized = shareUrl(body.url);
      if (shares.some((share, position) => position !== index && share.url === normalized)) throw new Error('Share already bookmarked');
      const bookmark = { ...(editing ? shares[index] : {}), id: editing ? shares[index].id : crypto.randomBytes(12).toString('hex'), name: String(body.name || new URL(normalized).hostname).trim().slice(0, 80), url: normalized };
      if (editing && new URL(shares[index].url).host + new URL(shares[index].url).pathname.split('/')[1] !== new URL(normalized).host + new URL(normalized).pathname.split('/')[1]) forgetSmbCredentials(bookmark);
      if (editing) shares[index] = bookmark; else shares.push(bookmark);
      fs.writeFileSync(file, JSON.stringify(shares, null, 2), { mode: 0o600 });
      json(response, 200, { shares: shares.map(publicSmbShare) });
    } else if (url.pathname === '/api/admin/smb/shares' && request.method === 'DELETE') {
      const body = await readJson(request, 8192);
      for (const share of shares.filter((item) => item.id === body.id)) forgetSmbCredentials(share);
      shares = shares.filter((share) => share.id !== body.id);
      fs.writeFileSync(file, JSON.stringify(shares, null, 2), { mode: 0o600 });
      json(response, 200, { shares: shares.map(publicSmbShare) });
    } else if (url.pathname === '/api/admin/smb/credentials' && ['POST', 'DELETE'].includes(request.method)) {
      const body = await readJson(request, 8192);
      const share = shares.find((item) => item.id === body.id);
      if (!share) throw new Error('Share bookmark not found');
      if (request.method === 'DELETE') forgetSmbCredentials(share); else storeSmbCredentials(share, body, dataDir);
      fs.writeFileSync(file, JSON.stringify(shares, null, 2), { mode: 0o600 });
      json(response, 200, { shares: shares.map(publicSmbShare) });
    } else if (url.pathname === '/api/admin/smb/browse' && request.method === 'GET') {
      const share = shares.find((item) => item.id === url.searchParams.get('share'));
      if (!share) throw new Error('Share bookmark not found');
      const folder = segments(url.searchParams.get('folder')).join('/');
      if (folder.length > 2048) throw new Error('Folder path is too long');
      const entries = await listDirectory(share, folder, dataDir);
      const pages = Math.ceil(entries.length / 100) || 1;
      const page = Math.max(1, Math.min(pages, Number.parseInt(url.searchParams.get('page'), 10) || 1));
      json(response, 200, { share: publicSmbShare(share), folder, entries: entries.slice((page - 1) * 100, page * 100), page, pages, total: entries.length });
    } else fail(response, 404, 'SMB route not found');
  } catch (error) {
    if (error.code === 'SMB_AUTH_REQUIRED') json(response, 409, { error: error.message, code: error.code });
    else fail(response, error.status || 400, error.message);
  }
  return true;
}
