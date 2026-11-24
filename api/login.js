// Franky Bot — login akun paper-trading.
// POST { username, password } -> { ok, session, username }.
// Password salah = pesan generik (tidak pernah bilang apakah username-nya
// ada). 5x gagal per username lalu kunci 15 menit; maks 30 percobaan
// per IP per 15 menit. Butuh Upstash Redis + SESSION_SECRET seperti signup.

import { makeUserSession } from '../lib/auth.js';
import {
  accountsEnabled,
  clientIp,
  getAccount,
  verifyPassword,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  hashPassword,
} from '../lib/accounts.js';
import { applyCors } from '../lib/cors.js';

const GENERIC = { ok: false, error: 'username-atau-password-salah' };

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  }
  if (!accountsEnabled()) {
    return res.status(503).json({
      ok: false,
      error: 'login-belum-dikonfigurasi',
      detail: 'Upstash Redis belum diisi di Environment Variables (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).',
    });
  }
  if (!process.env.SESSION_SECRET) {
    return res.status(503).json({ ok: false, error: 'session-secret-belum-diisi' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'username-dan-password-wajib' });
  }
  try {
    const rl = await checkLoginRateLimit(clientIp(req), username);
    if (!rl.ok) {
      return res.status(429).json({ ok: false, error: rl.error });
    }
    const account = await getAccount(username);
    if (!account) {
      // Username tidak ada: tetap jalankan scrypt sekali supaya waktu
      // responsnya mirip dengan password salah (tidak membocorkan ada/tidak).
      await hashPassword(password);
      return res.status(401).json(GENERIC);
    }
    const match = await verifyPassword(password, account.salt, account.hash);
    if (!match) {
      await recordLoginFailure(username);
      return res.status(401).json(GENERIC);
    }
    await clearLoginFailures(username);
    return res.status(200).json({ ok: true, session: makeUserSession(username), username });
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'login-gagal', detail: e.message });
  }
}
