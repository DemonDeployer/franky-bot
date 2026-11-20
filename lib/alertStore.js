// Franky Bot — dedup alert token baru (screener).
// Durable bila Upstash Redis tersedia (gratis, via REST, tanpa SDK):
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (isi di Vercel Dashboard).
// Bila tidak diisi, fallback ke map di state (/tmp) — best-effort, karena
// /tmp di Vercel bisa hilang saat fungsi di-recycle (lihat README).
// Redis TIDAK PERNAH menyimpan secret — hanya key "chain:alamat" token yang
// sudah dievaluasi (ZSET, score = epoch ms, dipangkas > 7 hari).
// Semua fungsi di sini tidak pernah throw — Redis gagal = fallback lokal.

const URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KEY = 'franky:screen:alerted';
const TTL_MS = 7 * 24 * 3600 * 1000; // simpan 7 hari
const MAX_LOCAL = 200;

export function alertStoreEnabled() {
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

// true bila key sudah dievaluasi sebelumnya (di mana pun).
export async function isAlerted(state, key) {
  if (state.newTokenAlerts && state.newTokenAlerts[key]) return true;
  if (!alertStoreEnabled()) return false;
  try {
    const r = await redis('ZSCORE', KEY, key);
    return r && r.result != null;
  } catch {
    return false; // Redis gagal — fallback ke map lokal.
  }
}

// Catat key sebagai sudah dievaluasi (lolos maupun tidak) + verdict-nya.
export async function markAlerted(state, key, verdict) {
  if (!state.newTokenAlerts) state.newTokenAlerts = {};
  state.newTokenAlerts[key] = { at: new Date().toISOString(), verdict };
  if (!alertStoreEnabled()) return;
  try {
    await redis('ZADD', KEY, Date.now(), key);
    await redis('ZREMRANGEBYSCORE', KEY, 0, Date.now() - TTL_MS);
  } catch {
    // Gagal tulis Redis — catatan lokal sudah cukup untuk siklus ini.
  }
}

// Pangkas map lokal ke 200 entri terakhir (key non-numerik menjaga urutan).
export function pruneAlerted(state) {
  const keys = Object.keys(state.newTokenAlerts || {});
  if (keys.length > MAX_LOCAL) {
    for (const k of keys.slice(0, keys.length - MAX_LOCAL)) delete state.newTokenAlerts[k];
  }
}
