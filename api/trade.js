// Franky Bot — beli/jual kertas untuk akun paper-trading.
// POST { action: 'buy', chain, address, usd } -> beli token (harga + vonis
//   keamanan dari Franky Check / lib/check.js — token BERBAHAYA ditolak).
// POST { action: 'sell', positionId } -> jual posisi (harga DexScreener).
// Uang simulasi saja, dari saldo kertas user; TIDAK PERNAH menyentuh
// portofolio global bot atau akun user lain. Batas sama seperti bot:
// maks $5/trade, maks 5 posisi, batas rugi harian. Butuh session akun paper.

import { userFromReq } from '../lib/auth.js';
import { CONFIG } from '../lib/config.js';
import { checkCoin } from '../lib/check.js';
import { tokenPriceUsd } from '../lib/dexscreener.js';
import {
  accountsEnabled,
  getPortfolio,
  savePortfolio,
  logPortfolio,
} from '../lib/accounts.js';
import { applyCors } from '../lib/cors.js';

const today = () => new Date().toISOString().slice(0, 10);

async function loadUser(username) {
  const p = await getPortfolio(username);
  if (p.daily.date !== today()) p.daily = { date: today(), pnlUsd: 0, buys: 0 };
  return p;
}

async function buy(username, body) {
  const chain = String(body.chain || 'solana').toLowerCase();
  const address = String(body.address || '').trim();
  const usd = Number(body.usd);
  if (!address) return { status: 400, body: { ok: false, error: 'alamat-token-wajib' } };
  if (!Number.isFinite(usd) || usd <= 0 || usd > CONFIG.maxBuyUsd) {
    return { status: 400, body: { ok: false, error: `jumlah-beli-maks-$${CONFIG.maxBuyUsd}` } };
  }
  const p = await loadUser(username);
  if (p.daily.pnlUsd <= -CONFIG.dailyLossLimitUsd) {
    return { status: 400, body: { ok: false, error: 'batas-rugi-harian' } };
  }
  if (p.positions.length >= CONFIG.maxPositions) {
    return { status: 400, body: { ok: false, error: `maks-${CONFIG.maxPositions}-posisi` } };
  }
  if (p.cash < usd) {
    return { status: 400, body: { ok: false, error: 'saldo-kertas-kurang' } };
  }
  const id = `${chain}:${address}`;
  if (p.positions.some((x) => x.id === id)) {
    return { status: 400, body: { ok: false, error: 'posisi-sudah-ada' } };
  }
  // Harga + vonis dari Franky Check (DexScreener + GoPlus). Token
  // BERBAHAYA (honeypot/rug/pajak tinggi) ditolak; WASPADA boleh dengan
  // peringatan yang ikut dikembalikan.
  let checked;
  try {
    checked = await checkCoin(chain, address);
  } catch (e) {
    const msg = e.message || 'gagal-mengecek-token';
    const status = /tidak dikenal|tidak valid/.test(msg) ? 400 : /tidak ditemukan/.test(msg) ? 404 : 502;
    return { status, body: { ok: false, error: msg } };
  }
  if (checked.verdict === 'BERBAHAYA') {
    return { status: 400, body: { ok: false, error: 'token-berbahaya', flags: checked.flags } };
  }
  const price = Number(checked.pair.priceUsd || 0);
  if (!price) return { status: 502, body: { ok: false, error: 'harga-tidak-didapat' } };
  const pos = {
    id,
    chain,
    symbol: checked.token.symbol || address.slice(0, 8),
    tokenAddress: address,
    pairAddress: checked.pair.pairAddress || '',
    entryPriceUsd: price,
    entryUsd: usd,
    boughtAt: new Date().toISOString(),
    txHash: null,
    paper: true,
    holders: checked.security?.holders || null,
  };
  p.cash = +(p.cash - usd).toFixed(2);
  p.positions.push(pos);
  p.daily.buys += 1;
  logPortfolio(p, `BELI ${pos.symbol} (${chain}) $${usd} @ $${price}`);
  await savePortfolio(username, p);
  return {
    status: 200,
    body: { ok: true, position: pos, cash: p.cash, verdict: checked.verdict, flags: checked.flags },
  };
}

async function sell(username, body) {
  const positionId = String(body.positionId || '').trim();
  if (!positionId) return { status: 400, body: { ok: false, error: 'positionId-wajib' } };
  const p = await loadUser(username);
  const pos = p.positions.find((x) => x.id === positionId);
  if (!pos) return { status: 404, body: { ok: false, error: 'posisi-tidak-ditemukan' } };
  const price = await tokenPriceUsd(pos.chain, pos.tokenAddress);
  if (!price) return { status: 502, body: { ok: false, error: 'harga-tidak-didapat' } };
  const pnlPct = ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
  const pnlUsd = +(pos.entryUsd * pnlPct) / 100;
  p.cash = +(p.cash + pos.entryUsd + pnlUsd).toFixed(2);
  p.daily.pnlUsd = +(p.daily.pnlUsd + pnlUsd).toFixed(2);
  p.positions = p.positions.filter((x) => x.id !== pos.id);
  const trade = {
    ...pos,
    exitPriceUsd: price,
    pnlPct: +pnlPct.toFixed(2),
    pnlUsd: +pnlUsd.toFixed(2),
    reason: 'manual',
    closedAt: new Date().toISOString(),
    exitTx: null,
  };
  p.trades.unshift(trade);
  logPortfolio(p, `JUAL ${pos.symbol} (manual) pnl ${pnlPct.toFixed(1)}%`);
  await savePortfolio(username, p);
  return { status: 200, body: { ok: true, trade, cash: p.cash } };
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method-not-allowed' });
  }
  const username = userFromReq(req);
  if (!username) {
    return res.status(401).json({ ok: false, error: 'login-dulu' });
  }
  if (!accountsEnabled()) {
    return res.status(503).json({ ok: false, error: 'akun-belum-dikonfigurasi' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const out = body.action === 'buy' ? await buy(username, body)
      : body.action === 'sell' ? await sell(username, body)
      : { status: 400, body: { ok: false, error: 'action-tidak-dikenal' } };
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'trade-gagal', detail: e.message });
  }
}
