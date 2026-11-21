// Franky Bot — penyimpanan state sederhana (file JSON).
// Di Vercel, /tmp bisa hilang saat fungsi di-recycle. Untuk pemakaian serius,
// ganti file ini dengan Vercel KV / Upstash Redis.
// Di Altare (ALTARE=1), state tinggal di ./data/franky-state.json supaya
// tetap ada antar Job (cron) — disk aplikasi Altare persisten.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE =
  process.env.ALTARE === '1'
    ? path.join(process.cwd(), 'data', 'franky-state.json')
    : '/tmp/franky-state.json';

const blank = () => ({
  positions: [], // posisi terbuka
  trades: [], // riwayat trade yang sudah ditutup
  daily: { date: '', pnlUsd: 0, buys: 0 },
  logs: [], // log terbaru di depan, maks 200
  paused: false, // dijeda via /stop di Telegram — cron tetap jalan tapi tidak beli/jual
  screenEnabled: true, // screener token baru AKTIF (diatur via /screen on|off)
});

export async function loadState() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return blank();
  }
}

export async function saveState(state) {
  state.trades = state.trades.slice(0, 200);
  state.logs = state.logs.slice(0, 200);
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(state));
}

export function log(state, msg) {
  state.logs.unshift({ t: new Date().toISOString(), msg });
  state.logs = state.logs.slice(0, 200);
}
