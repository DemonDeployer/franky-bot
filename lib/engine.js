// Franky Bot — otak bot. Satu siklus:
//  1. Cek posisi terbuka: jual bila kena take-profit / stop-loss / max hold.
//  2. Bila rugi harian tembus batas, berhenti beli hari itu.
//  3. Scan pair terbaru tiap chain aktif, filter, cek keamanan, lalu beli.
//  4. Alert-only (tidak beli/jual): token/pair BARU yang lolos Kill-Switch
//     Filter (onchain-alpha-and-liquidity-hunter) dikirim ke Telegram.
//
// CATATAN: library chain berat (ethers, @solana/web3.js) sengaja di-import
// LAZY (dynamic import) hanya saat transaksi live. Import statis di atas
// membuat /api/scan crash di Vercel (FUNCTION_INVOCATION_FAILED) karena
// bundler serverless gagal memuat dependency besar itu saat cold start.
// Mode kertas tidak pernah menyentuh library itu, jadi scan jalan tanpa mereka.

import { CONFIG, CHAINS } from './config.js';
import { loadState, saveState, log } from './store.js';
import { isAlerted, markAlerted, pruneAlerted } from './alertStore.js';
import { tokenPriceUsd } from './dexscreener.js';
import { latestPools } from './geckoterminal.js';
import { checkToken, fetchSecurity } from './security.js';
import { killSwitchFor } from './check.js';
import { pairPasses, scorePair } from './strategy.js';
import { notifyBuy, notifySell, notifyNewToken } from './telegram.js';

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Harga USD dari wrapped native (WBNB/WETH/WHYPE) via DexScreener.
async function wrappedPriceUsd(chain) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chain.wrappedNative}`);
    const j = await r.json();
    const p = (j.pairs || []).find((x) => Number(x.priceUsd) > 0);
    return p ? Number(p.priceUsd) : 0;
  } catch {
    return 0;
  }
}

async function executeBuy(chain, pair) {
  if (CONFIG.dryRun) return { paper: true };
  if (chain.id === 'solana') {
    const { solanaBuy } = await import('./solana.js');
    return solanaBuy(pair.baseToken.address, CONFIG.maxBuyUsd, CONFIG.slippageBps);
  }
  const { ethers } = await import('ethers');
  const { evmBuy } = await import('./evm.js');
  const price = await wrappedPriceUsd(chain);
  if (!price) throw new Error(`harga ${chain.native} tidak didapat`);
  const nativeAmount = ethers.parseEther(String(CONFIG.maxBuyUsd / price));
  return evmBuy(chain, pair.baseToken.address, nativeAmount, CONFIG.slippageBps);
}

async function executeSell(pos) {
  if (CONFIG.dryRun) return { paper: true };
  const chain = CHAINS[pos.chain];
  if (pos.chain === 'solana') {
    const { solanaSell } = await import('./solana.js');
    return solanaSell(pos.tokenAddress, CONFIG.slippageBps);
  }
  const { evmSell } = await import('./evm.js');
  return evmSell(chain, pos.tokenAddress, CONFIG.slippageBps);
}

// Alert token/pair BARU (onchain-alpha-and-liquidity-hunter Step 1 + 2).
// ALERT-ONLY: hanya mengevaluasi kill-switch lalu mengirim Telegram bila
// lolos (PASS). Tidak beli, tidak jual, tidak mengubah posisi atau
// keputusan trading apa pun.
//   pairs: daftar pair baru dari GeckoTerminal (sudah difilter: belum ada
//     di posisi / trade hari ini), diurutkan likuiditas terbesar dulu.
//   budget: { left } bersama untuk semua chain — maks ~5 evaluasi per
//     siklus supaya GoPlus (30/menit) aman.
//   Dedupe: lib/alertStore.js — setiap alamat yang SUDAH dievaluasi (lolos
//     maupun tidak, beserta verdict-nya) tercatat durable di Upstash Redis
//     bila dikonfigurasi, fallback ke map di state (/tmp, best-effort).
//     Token tidak pernah di-alert dua kali selama catatannya masih ada.
export async function alertNewTokens(chain, chainId, pairs, state, summary, budget) {
  if (!state.newTokenAlerts) state.newTokenAlerts = {};
  if (!Array.isArray(state.logs)) state.logs = []; // log() butuh state.logs
  if (!summary.rejectedByRule) summary.rejectedByRule = {};
  const fresh = pairs
    .filter((p) => {
      // JANGAN lowercase alamat: Solana base58 case-sensitive — lowercase
      // merusak alamat ('L' jadi 'l' yang bukan base58) dan membuat key
      // dedup tidak cocok dengan id posisi (yang memakai alamat asli).
      const addr = String(p.baseToken?.address || '');
      if (!addr) return false;
      const key = `${chainId}:${addr}`;
      if (state.newTokenAlerts[key]) return false; // sudah dievaluasi (lokal)
      if (state.positions.some((x) => x.id === key)) return false; // sudah dibeli
      return true;
    })
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));

  for (const pair of fresh) {
    if (budget.left <= 0) break;
    const addr = String(pair.baseToken.address);
    const key = `${chainId}:${addr}`;
    // Cek durable (Redis) — token bisa sudah dievaluasi di invocasi lain.
    if (await isAlerted(state, key)) continue;
    budget.left -= 1;
    summary.screenedNew += 1;
    try {
      const sec = await fetchSecurity(chain.goplus, addr, [pair.pairAddress], chain.rpc);
      const kill = killSwitchFor(pair, sec);
      await markAlerted(state, key, kill.verdict);
      if (!kill.pass) {
        for (const r of kill.reasons) summary.rejectedByRule[r.code] = (summary.rejectedByRule[r.code] || 0) + 1;
        log(state, `ALERT-SKIP ${pair.baseToken.symbol} (${chain.label}): ${kill.reasons.map((r) => r.code).join(',')}`);
        continue;
      }
      const h = (sec && sec.holders) || {};
      await notifyNewToken({
        chainId,
        chainLabel: chain.label,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.symbol,
        tokenAddress: addr,
        pairAddress: pair.pairAddress,
        dexSlug: chain.dexscreener,
        priceUsd: Number(pair.priceUsd || 0),
        liquidityUsd: Number(pair?.liquidity?.usd || 0),
        fdvUsd: Number(pair.fdv || 0),
        marketCapUsd: Number(pair.marketCap || 0),
        buyTax: Number(sec.buyTax || 0),
        sellTax: Number(sec.sellTax || 0),
        top10Pct: Number(h.top10Pct || 0),
        lpBurnPct: Number(h.lpBurnPct || 0),
        lpLockedPct: Number(h.lpLockedPct || 0),
        ageMin: pair.pairCreatedAt ? Math.max(0, Math.round((Date.now() - Number(pair.pairCreatedAt)) / 60000)) : null,
        volumeH1: Number(pair?.volume?.h1 || 0),
      });
      summary.alerts.push({ symbol: pair.baseToken.symbol, chain: chainId });
      log(state, `ALERT BARU ${pair.baseToken.symbol} (${chain.label}) lolos kill-switch`);
    } catch (e) {
      summary.errors.push(`alert ${pair.baseToken.symbol}: ${e.message}`);
    }
    // Jeda singkat antar cek keamanan supaya GoPlus (30/menit) tidak kena 429.
    await sleep(400);
  }

  // Pangkas map lokal supaya state tidak membengkak (200 entri terakhir).
  pruneAlerted(state);
}

export async function runCycle(trigger = 'cron') {
  const state = await loadState();
  if (state.daily.date !== today()) state.daily = { date: today(), pnlUsd: 0, buys: 0 };

  const summary = {
    trigger,
    at: new Date().toISOString(),
    dryRun: CONFIG.dryRun,
    scanned: 0,
    candidates: 0,
    buys: [],
    sells: [],
    skipped: [],
    errors: [],
    alerts: [], // token baru yang lolos kill-switch dan di-alert ke Telegram
    screenedNew: 0, // token baru yang dievaluasi kill-switch siklus ini
  };

  // Dijeda via /stop di Telegram — cron tetap jalan tapi tidak beli/jual.
  if (state.paused) {
    summary.skipped.push('paused (dijeda via Telegram)');
    await saveState(state);
    return summary;
  }

  // 1. Kelola posisi terbuka.
  for (const pos of [...state.positions]) {
    try {
      const price = await tokenPriceUsd(CHAINS[pos.chain].dexscreener, pos.tokenAddress);
      if (!price) continue;
      const pnlPct = ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const ageH = (Date.now() - new Date(pos.boughtAt).getTime()) / 3600000;
      let reason = null;
      if (pnlPct >= CONFIG.takeProfitPct) reason = `TP +${pnlPct.toFixed(1)}%`;
      else if (pnlPct <= -CONFIG.stopLossPct) reason = `SL ${pnlPct.toFixed(1)}%`;
      else if (ageH >= CONFIG.maxHoldHours) reason = `max-hold ${ageH.toFixed(1)}j`;
      if (!reason) continue;

      const result = await executeSell(pos);
      const pnlUsd = (pos.entryUsd * pnlPct) / 100;
      state.daily.pnlUsd += pnlUsd;
      state.positions = state.positions.filter((p) => p.id !== pos.id);
      state.trades.unshift({
        ...pos,
        exitPriceUsd: price,
        pnlPct: +pnlPct.toFixed(2),
        pnlUsd: +pnlUsd.toFixed(2),
        reason,
        closedAt: new Date().toISOString(),
        exitTx: result?.txHash || result?.signature || null,
      });
      summary.sells.push({ symbol: pos.symbol, reason, pnlPct: +pnlPct.toFixed(2) });
      log(state, `JUAL ${pos.symbol} (${reason}) pnl ${pnlPct.toFixed(1)}%`);
      await notifySell({ ...pos, exitPriceUsd: price, pnlPct, pnlUsd, reason, closedAt: new Date().toISOString() });
    } catch (e) {
      summary.errors.push(`sell ${pos.symbol}: ${e.message}`);
    }
  }

  // 2. Batas rugi harian.
  if (state.daily.pnlUsd <= -CONFIG.dailyLossLimitUsd) {
    summary.skipped.push('daily-loss-limit');
    await saveState(state);
    return summary;
  }

  // 3. Scan & beli. Jeda antar chain supaya GeckoTerminal (gratis, limit
  // ~30 req/menit per IP bersama) tidak langsung 429.
  // Budget alert: maks ~5 token baru dievaluasi kill-switch per siklus
  // (total semua chain) supaya GoPlus (30/menit) aman.
  const alertBudget = { left: 5 };
  let firstChain = true;
  for (const chainId of CONFIG.enabledChains) {
    const chain = CHAINS[chainId];
    if (!chain) continue;
    if (!firstChain) await sleep(1500);
    firstChain = false;
    try {
      const pairs = await latestPools(chain.gecko);
      summary.scanned += pairs.length;
      const fresh = pairs
        .filter(
          (p) =>
            !state.positions.some((x) => x.id === `${chainId}:${p.baseToken.address}`) &&
            !state.trades.some(
              (t) =>
                t.id === `${chainId}:${p.baseToken.address}` &&
                t.closedAt?.slice(0, 10) === today(),
            ),
        )
        .sort((a, b) => scorePair(b) - scorePair(a));

      for (const pair of fresh.slice(0, 10)) {
        if (state.positions.length >= CONFIG.maxPositions) break;
        const pass = pairPasses(pair);
        if (!pass.ok) continue;
        summary.candidates += 1;

        const sec = await checkToken(chain.goplus, pair.baseToken.address, [pair.pairAddress]);
        if (!sec.ok) {
          log(state, `SKIP ${pair.baseToken.symbol} (${chain.label}): ${sec.reason}`);
          continue;
        }

        const entryPrice = Number(pair.priceUsd || 0);
        if (!entryPrice) continue;

        try {
          const result = await executeBuy(chain, pair);
          const pos = {
            id: `${chainId}:${pair.baseToken.address}`,
            chain: chainId,
            symbol: pair.baseToken.symbol,
            tokenAddress: pair.baseToken.address,
            pairAddress: pair.pairAddress,
            entryPriceUsd: entryPrice,
            entryUsd: CONFIG.maxBuyUsd,
            boughtAt: new Date().toISOString(),
            txHash: result?.txHash || result?.signature || null,
            paper: !!CONFIG.dryRun,
            holders: sec.holders || null,
          };
          state.positions.push(pos);
          state.daily.buys += 1;
          summary.buys.push({ symbol: pos.symbol, chain: chainId, price: entryPrice, tx: pos.txHash, holders: sec.holders || null });
          log(state, `BELI ${pos.symbol} (${chain.label}) $${CONFIG.maxBuyUsd} @ $${entryPrice}`);
          await notifyBuy(pos);
        } catch (e) {
          summary.errors.push(`buy ${pair.baseToken.symbol}: ${e.message}`);
          log(state, `GAGAL BELI ${pair.baseToken.symbol}: ${e.message}`);
        }
      }

      // 4. Alert-only: token/pair BARU yang lolos kill-switch dikirim ke
      // Telegram. Tidak beli/jual, tidak mengubah posisi — murni monitoring.
      await alertNewTokens(chain, chainId, fresh, state, summary, alertBudget);
    } catch (e) {
      summary.errors.push(`scan ${chainId}: ${e.message}`);
    }
  }

  await saveState(state);
  return summary;
}
