import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sessions = new Map();
let readers = 0;
const loopback = (request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);

export function smbMediaSession(shareId, url, port) {
  for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
  while (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { shareId, url, expires: Date.now() + 48 * 60 * 60 * 1000 });
  return `http://127.0.0.1:${port}/api/internal/smb-media/${token}`;
}

export async function handleSmbMediaRequest({ request, response, url, resolve, json }) {
  if (!url.pathname.startsWith('/api/internal/smb-media/')) return false;
  const token = url.pathname.slice('/api/internal/smb-media/'.length);
  const session = /^[a-f0-9]{64}$/.test(token) ? sessions.get(token) : null;
  if (!loopback(request) || !['GET', 'HEAD'].includes(request.method) || !session || session.expires < Date.now()) {
    json(response, 403, { error: 'Private SMB media endpoint' }); return true;
  }
  if (readers >= 6) { json(response, 503, { error: 'SMB reader limit reached' }); return true; }
  let file;
  try { file = resolve(session.shareId, session.url); }
  catch { json(response, 403, { error: 'SMB bookmark or sign-in is unavailable' }); return true; }
  const range = String(request.headers.range || '');
  if (range.length > 100) { json(response, 400, { error: 'Invalid byte range' }); return true; }
  readers += 1;
  const child = spawn('python3', ['-u', fileURLToPath(new URL('./smb-stream.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] });
  let header = Buffer.alloc(0), ready = false, completed = false;
  const timeout = setTimeout(() => {
    if (!ready && !response.destroyed) json(response, 504, { error: 'SMB file did not open within 15 seconds' });
    child.kill('SIGKILL');
  }, 15_000);
  const fail = (reason) => {
    if (response.destroyed || response.writableEnded) return;
    console.error(`SMB relay: ${reason}`);
    if (!response.headersSent) json(response, 502, { error: reason }); else response.destroy();
  };
  child.once('error', () => fail('Could not start the SMB reader; check the image dependencies'));
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ ...file, range, head: request.method === 'HEAD' }));
  const onHeader = (chunk) => {
    header = Buffer.concat([header, chunk]);
    const newline = header.indexOf(10);
    if (newline < 0) {
      if (header.length > 4096) { fail('Invalid SMB reader response'); child.kill('SIGKILL'); }
      return;
    }
    clearTimeout(timeout);
    child.stdout.pause(); child.stdout.removeListener('data', onHeader);
    let info;
    try { info = JSON.parse(header.subarray(0, newline).toString('utf8')); }
    catch { fail('Invalid SMB reader response'); child.kill('SIGKILL'); return; }
    if (info.status === 416) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Cache-Control': 'no-store' }); response.end(); child.kill(); return;
    }
    if (![200, 206].includes(info.status) || !Number.isSafeInteger(info.length) || info.length < 0) {
      fail(info.error || 'SMB reader could not open this file'); child.kill(); return;
    }
    ready = true;
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': info.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (info.status === 206) headers['Content-Range'] = `bytes ${info.start}-${info.end}/${info.size}`;
    response.writeHead(info.status, headers);
    if (request.method === 'HEAD') { response.end(); child.kill(); return; }
    const first = header.subarray(newline + 1); header = null;
    // pipe() handles subsequent backpressure; don't resume until the first chunk drains.
    if (first.length && !response.write(first)) response.once('drain', () => child.stdout.pipe(response));
    else child.stdout.pipe(response);
  };
  child.stdout.on('data', onHeader);
  child.stdout.once('end', () => { completed = true; });
  child.once('close', (code) => {
    readers -= 1; clearTimeout(timeout);
    if (code !== 0 && !response.destroyed && !response.writableEnded) fail('SMB read failed while streaming the file');
    else if (!ready && !response.writableEnded && !response.destroyed) fail('SMB reader returned no file information');
  });
  response.once('close', () => { if (!completed) child.kill('SIGKILL'); });
  return true;
}
