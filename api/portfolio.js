// Franky Bot — portofolio akun paper-trading.
// GET -> { ok, username, cash, startingBalance, positions, trades, daily,
//   logs, limits } (portofolio user yang login; bukan state global bot).
// POST { action: 'reset' } -> kembalikan portofolio ke saldo awal
// (posisi + riwayat dihapus), seperti tombol reset di TradePaper.
// Butuh session akun paper (Bearer); session Google TIDAK berlaku di sini.

import { userFromReq } from '../lib/auth.js';
import { CONFIG } from '../lib/config.js';
import {
  accountsEnabled,
  getPortfolio,
  savePortfolio,
  blankPortfolio,
  logPortfolio,
} from '../lib/accounts.js';
import { applyCors } from '../lib/cors.js';

const today = () => new Date().toISOString().slice(0, 10);

function limits() {
  return {
    maxBuyUsd: CONFIG.maxBuyUsd,
    maxPositions: CONFIG.maxPositions,
    takeProfitPct: CONFIG.takeProfitPct,
    stopLossPct: CONFIG.stopLossPct,
    maxHoldHours: CONFIG.maxHoldHours,
    dailyLossLimitUsd: CONFIG.dailyLossLimitUsd,
  };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  const username = userFromReq(req);
  if (!username) {
    return res.status(401).json({ ok: false, error: 'login-dulu' });
  }
  if (!accountsEnabled()) {
    return res.status(503).json({ ok: false, error: 'akun-belum-dikonfigurasi' });
  }
  try {
    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (body.action !== 'reset') {
        return res.status(400).json({ ok: false, error: 'action-tidak-dikenal' });
      }
      const account = await getPortfolio(username);
      const fresh = blankPortfolio(account.startingBalance);
      logPortfolio(fresh, 'RESET portofolio ke saldo awal');
      await savePortfolio(username, fresh);
      return res.status(200).json({
        ok: true,
        username,
        cash: fresh.cash,
        startingBalance: fresh.startingBalance,
        positions: [],
        trades: [],
        daily: fresh.daily,
        logs: fresh.logs,
        limits: limits(),
      });
    }
    if (req.method !== 'GET') {
      return res.status(405).json({ ok: false, error: 'method-not-allowed' });
    }
    const p = await getPortfolio(username);
    if (p.daily.date !== today()) p.daily = { date: today(), pnlUsd: 0, buys: 0 };
    return res.status(200).json({
      ok: true,
      username,
      cash: p.cash,
      startingBalance: p.startingBalance,
      positions: p.positions,
      trades: (p.trades || []).slice(0, 50),
      daily: p.daily,
      logs: (p.logs || []).slice(0, 100),
      limits: limits(),
    });
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'gagal-memuat-portofolio', detail: e.message });
  }
}
