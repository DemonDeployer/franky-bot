// Franky Bot — akun paper-trading (daftar terbuka, ala TradePaper).
// Username + password saja, tanpa email / wallet / kartu. Uang simulasi USD.
// Penyimpanan durable di Upstash Redis via REST (tanpa SDK), pola yang sama
// seperti lib/alertStore.js: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
// Bila env vars tidak diisi, signup/login menolak tegas (503) — akun tidak
// pernah disimpan diam-diam di /tmp lalu hilang saat fungsi di-recycle.
// Password: scrypt + salt acak per user; plaintext TIDAK PERNAH disimpan
// atau di-log. Session: HMAC di lib/auth.js (makeUserSession /
// verifyUserSession). Rate limit di Redis; semua fungsi Redis gagal =
// throw, supaya pemanggil mengembalikan error jujur, bukan data palsu.

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

const URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const STARTING_BALANCES = [1000, 5000, 10000, 100000];
export const DEFAULT_BALANCE = 10000;

export function accountsEnabled() {
  return Boolean(URL && TOKEN);
}

async function redis(cmd, ...args) {
  const res = await fetch(
    `${URL}/${cmd}/${args.map((a) => encodeURIComponent(String(a))).join('/')}`,
    { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return res.json();
}

// IP klien (Vercel menaruhnya di x-forwarded-for). Disanitasi untuk key Redis.
export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = fwd || req.socket?.remoteAddress || 'unknown';
  return raw.replace(/[^A-Za-z0-9.:-]/g, '-').slice(0, 64);
}

// --- Password (scrypt, salt acak per user) ---
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt, hash: hash.toString('hex') };
}

export async function verifyPassword(password, salt, hashHex) {
  try {
    const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const a = Buffer.from(hashHex, 'hex');
    const b = Buffer.from(hash);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- Akun ---
// Key: franky:user:<username> -> JSON { v, username, salt, hash,
// startingBalance, createdAt }. SET NX = atomik, duplikat tidak mungkin
// lolos walau dua daftar bersamaan.
const userKey = (u) => `franky:user:${u}`;

export async function getAccount(username) {
  const r = await redis('GET', userKey(username));
  if (!r || r.result == null) return null;
  try {
    return JSON.parse(r.result);
  } catch {
    return null;
  }
}

// { ok: true, account } atau { ok: false, error: 'username-sudah-dipakai' }.
export async function createAccount(username, password, startingBalance) {
  const { salt, hash } = await hashPassword(password);
  const account = {
    v: 1,
    username,
    salt,
    hash,
    startingBalance,
    createdAt: new Date().toISOString(),
  };
  const r = await redis('SET', userKey(username), JSON.stringify(account), 'NX');
  if (!r || r.result !== 'OK') return { ok: false, error: 'username-sudah-dipakai' };
  return { ok: true, account };
}

// --- Portofolio per user ---
// Key: franky:portfolio:<username> -> JSON { cash, startingBalance,
// positions, trades, daily, logs }. Bentuk posisi sama seperti bot
// (lib/engine.js): { id, chain, symbol, tokenAddress, pairAddress,
// entryPriceUsd, entryUsd, boughtAt, txHash, paper, holders }.
const portfolioKey = (u) => `franky:portfolio:${u}`;

export function blankPortfolio(startingBalance) {
  return {
    cash: startingBalance,
    startingBalance,
    positions: [],
    trades: [],
    daily: { date: '', pnlUsd: 0, buys: 0 },
    logs: [],
  };
}

export function logPortfolio(p, msg) {
  if (!Array.isArray(p.logs)) p.logs = [];
  p.logs.unshift({ t: new Date().toISOString(), msg });
  p.logs = p.logs.slice(0, 200);
}

// Bila portofolio belum ada, buat dari saldo awal akun (daftar yang
// portofolionya gagal dibuat tetap bisa dipakai).
export async function getPortfolio(username) {
  const r = await redis('GET', portfolioKey(username));
  if (r && r.result != null) {
    try {
      const p = JSON.parse(r.result);
      if (p && typeof p.cash === 'number') return p;
    } catch {
      // rusak — buat ulang di bawah
    }
  }
  const account = await getAccount(username);
  const p = blankPortfolio(account?.startingBalance || DEFAULT_BALANCE);
  try {
    await redis('SET', portfolioKey(username), JSON.stringify(p));
  } catch {
    // Redis gagal sesaat: kembalikan portofolio kosong; save berikutnya
    // yang akan gagal tegas.
  }
  return p;
}

export async function savePortfolio(username, portfolio) {
  if (Array.isArray(portfolio.trades)) portfolio.trades = portfolio.trades.slice(0, 200);
  if (Array.isArray(portfolio.logs)) portfolio.logs = portfolio.logs.slice(0, 200);
  await redis('SET', portfolioKey(username), JSON.stringify(portfolio));
}

// --- Rate limit (Redis; gagal Redis = throw, pemanggil balas 503) ---
async function incrWithExpiry(key, seconds) {
  const r = await redis('INCR', key);
  const n = Number(r?.result || 0);
  if (n === 1) {
    try {
      await redis('EXPIRE', key, seconds);
    } catch {
      // abaikan — counter tanpa TTL tetap membatasi dalam jendela ini
    }
  }
  return n;
}

// Daftar: maks 10/jam per IP. { ok: true } atau { ok: false }.
export async function checkSignupRateLimit(ip) {
  const n = await incrWithExpiry(`franky:rl:signup:${ip}`, 3600);
  return { ok: n <= 10 };
}

// Login: maks 30 percobaan / 15 menit per IP, dan maks 5 gagal / 15 menit
// per username lalu kunci 15 menit. { ok: true } atau
// { ok: false, error: 'terlalu-banyak-percobaan' }.
export async function checkLoginRateLimit(ip, username) {
  const locked = await redis('GET', `franky:lock:login:${username}`);
  if (locked && locked.result != null) return { ok: false, error: 'terlalu-banyak-percobaan' };
  const n = await incrWithExpiry(`franky:rl:loginip:${ip}`, 900);
  if (n > 30) return { ok: false, error: 'terlalu-banyak-percobaan' };
  return { ok: true };
}

export async function recordLoginFailure(username) {
  const n = await incrWithExpiry(`franky:rl:loginfail:${username}`, 900);
  if (n >= 5) {
    try {
      await redis('SET', `franky:lock:login:${username}`, '1', 'EX', 900);
    } catch {
      // kunci gagal ditulis — counter tetap membatasi lewat check di atas
    }
  }
}

export async function clearLoginFailures(username) {
  try {
    await redis('DEL', `franky:rl:loginfail:${username}`, `franky:lock:login:${username}`);
  } catch {
    // abaikan — counter kedaluwarsa sendiri
  }
}
