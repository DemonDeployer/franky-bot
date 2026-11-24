// Franky Bot — auth sesi via Google Sign-In (opsional).
// Aktif hanya bila ALLOWED_EMAIL diisi. Tanpa itu, API tetap terbuka seperti sebelumnya.
// Session Google = email|expiry|HMAC-SHA256(email|expiry, SESSION_SECRET), base64url.
// Session akun paper (username) = u|username|expiry|HMAC-SHA256(u|username|expiry,
// SESSION_SECRET), base64url — format berbeda (awalan "u|") supaya tidak
// pernah tertukar dengan session Google. Keduanya 7 hari.

import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function secret() {
  return process.env.SESSION_SECRET || '';
}

export function authEnabled() {
  return Boolean(process.env.ALLOWED_EMAIL);
}

export function makeSession(email) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${email}|${exp}`;
  const sig = createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

export function verifySession(token) {
  try {
    if (!secret() || !token) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const [email, exp, sig] = raw.split('|');
    if (!email || !exp || !sig) return null;
    if (Number(exp) < Date.now()) return null;
    if (email.toLowerCase() !== String(process.env.ALLOWED_EMAIL || '').toLowerCase()) return null;
    const expect = createHmac('sha256', secret()).update(`${email}|${exp}`).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expect, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return email;
  } catch {
    return null;
  }
}

export function sessionFromReq(req) {
  const h = req.headers.authorization || '';
  const token = h.replace('Bearer ', '').trim();
  return verifySession(token);
}

// --- Session akun paper (username) — lib/accounts.js ---
// Sengaja terpisah dari session Google: sessionFromReq/requireAuth di atas
// tetap Google-only, supaya akun paper TIDAK BISA memicu /api/scan atau
// /api/screen (itu tetap butuh CRON_SECRET atau session Google).

export function makeUserSession(username) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `u|${username}|${exp}`;
  const sig = createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

// Mengembalikan username bila token akun paper valid, null bila tidak.
export function verifyUserSession(token) {
  try {
    if (!secret() || !token) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const [kind, username, exp, sig] = raw.split('|');
    if (kind !== 'u' || !username || !exp || !sig) return null;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return null;
    if (Number(exp) < Date.now()) return null;
    const expect = createHmac('sha256', secret()).update(`u|${username}|${exp}`).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expect, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return username;
  } catch {
    return null;
  }
}

export function userFromReq(req) {
  const h = req.headers.authorization || '';
  const token = h.replace('Bearer ', '').trim();
  return verifyUserSession(token);
}

// true bila request boleh lanjut.
export function requireAuth(req) {
  if (!authEnabled()) return true;
  return Boolean(sessionFromReq(req));
}
