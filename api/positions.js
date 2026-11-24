// Franky Bot — status bot untuk dashboard (tanpa data rahasia).
// Bila ALLOWED_EMAIL diisi, endpoint ini butuh session Google yang valid.
// Bila yang login adalah AKUN PAPER (session username), endpoint ini
// mengembalikan portofolio user itu — bukan state global bot.

import { loadState } from '../lib/store.js';
import { CONFIG, CHAINS } from '../lib/config.js';
import { requireAuth, userFromReq } from '../lib/auth.js';
import { getPortfolio } from '../lib/accounts.js';
import { applyCors } from '../lib/cors.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  // Akun paper: portofolio sendiri, bukan state global bot.
  const username = userFromReq(req);
  if (username) {
    try {
      const p = await getPortfolio(username);
      return res.status(200).json({
        ok: true,
        userPortfolio: true,
        username,
        cash: p.cash,
        startingBalance: p.startingBalance,
        mode: 'PAPER',
        chains: CONFIG.enabledChains.map((id) => CHAINS[id]?.label || id),
        limits: {
          maxBuyUsd: CONFIG.maxBuyUsd,
          maxPositions: CONFIG.maxPositions,
          takeProfitPct: CONFIG.takeProfitPct,
          stopLossPct: CONFIG.stopLossPct,
          maxHoldHours: CONFIG.maxHoldHours,
          dailyLossLimitUsd: CONFIG.dailyLossLimitUsd,
        },
        positions: p.positions,
        trades: (p.trades || []).slice(0, 50),
        daily: p.daily,
        logs: (p.logs || []).slice(0, 100),
      });
    } catch (e) {
      return res.status(503).json({ ok: false, error: 'gagal-memuat-portofolio', detail: e.message });
    }
  }
  if (!requireAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized', authRequired: true });
  }
  const state = await loadState();
  return res.status(200).json({
    ok: true,
    mode: CONFIG.dryRun ? 'PAPER' : 'LIVE',
    chains: CONFIG.enabledChains.map((id) => CHAINS[id]?.label || id),
    limits: {
      maxBuyUsd: CONFIG.maxBuyUsd,
      maxPositions: CONFIG.maxPositions,
      takeProfitPct: CONFIG.takeProfitPct,
      stopLossPct: CONFIG.stopLossPct,
      maxHoldHours: CONFIG.maxHoldHours,
      dailyLossLimitUsd: CONFIG.dailyLossLimitUsd,
    },
    positions: state.positions,
    trades: state.trades.slice(0, 50),
    daily: state.daily,
    logs: state.logs.slice(0, 100),
  });
}
