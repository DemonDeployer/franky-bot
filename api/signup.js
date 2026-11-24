// Franky Bot — daftar akun paper-trading (ala TradePaper).
// POST { username, password, startingBalance? } -> { ok, session, username,
// startingBalance }.
// Username 3–20 karakter (huruf/angka/underscore), password min 8 karakter.
// Saldo awal simulasi USD: 1000 / 5000 / 10000 / 100000 (default 10000).
// Tanpa email, tanpa wallet, tanpa kartu. Uang simulasi saja.
// Butuh Upstash Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
// dan SESSION_SECRET — bila belum diisi, balas 503 jujur, jangan pernah
// menyimpan akun di /tmp lalu hilang.

import { makeUserSession } from '../lib/auth.js';
import {
  accountsEnabled,
  clientIp,
  checkSignupRateLimit,
  createAccount,
  getPortfolio,
  STARTING_BALANCES,
  DEFAULT_BALANCE,
} from '../lib/accounts.js';
import { applyCors } from '../lib/cors.js';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  }
  if (!accountsEnabled()) {
    return res.status(503).json({
      ok: false,
      error: 'signup-belum-dikonfigurasi',
      detail: 'Upstash Redis belum diisi di Environment Variables (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).',
    });
  }
  if (!process.env.SESSION_SECRET) {
    return res.status(503).json({ ok: false, error: 'session-secret-belum-diisi' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  let startingBalance = Number(body.startingBalance ?? DEFAULT_BALANCE);
  if (!STARTING_BALANCES.includes(startingBalance)) startingBalance = DEFAULT_BALANCE;
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ ok: false, error: 'username-tidak-valid' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ ok: false, error: 'password-min-8-karakter' });
  }
  try {
    const rl = await checkSignupRateLimit(clientIp(req));
    if (!rl.ok) {
      return res.status(429).json({ ok: false, error: 'terlalu-banyak-percobaan' });
    }
    const created = await createAccount(username, password, startingBalance);
    if (!created.ok) {
      return res.status(409).json({ ok: false, error: created.error });
    }
    // Portofolio dibuat di awal supaya saldo langsung terlihat.
    await getPortfolio(username);
    return res.status(201).json({
      ok: true,
      session: makeUserSession(username),
      username,
      startingBalance,
    });
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'penyimpanan-akun-gagal', detail: e.message });
  }
}
