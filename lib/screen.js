// Franky Bot — screener token baru (ALERT-ONLY, tanpa trading).
// Siklus khusus screening: ambil pair terbaru dari GeckoTerminal tiap
// chain, jalankan Kill-Switch Filter (onchain-alpha-and-liquidity-hunter),
// kirim Telegram HANYA bila PASS. Tidak beli, tidak jual, tidak menyentuh
// posisi, tidak mengubah DRY_RUN. Dipanggil /api/screen (cron harian +
// manual), terpisah dari siklus trading /api/scan.
//   Chain yang dievaluasi: solana, bsc, base (punya data keamanan GoPlus /
//     RugCheck). HyperEVM TIDAK dievaluasi: GoPlus tidak mendukung chain
//     itu, jadi kill-switch selalu gagal fail-closed (NO_SEC) — dicatat
//     sebagai unsupported-for-now di summary, bukan dipalsukan.
//   Dedup: lib/alertStore.js (Upstash Redis bila dikonfigurasi, fallback
//     map di state). Token yang sudah dievaluasi tidak dicek ulang.
//   Screener bisa dimatikan via /screen off (state.screenEnabled); default
//     AKTIF. /stop (jeda trading) TIDAK mematikan screener.

import { CONFIG, CHAINS } from './config.js';
import { loadState, saveState, log } from './store.js';
import { latestPools } from './geckoterminal.js';
import { alertNewTokens } from './engine.js';
import { alertStoreEnabled } from './alertStore.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chain yang punya data keamanan (GoPlus/RugCheck) dan bisa dievaluasi.
const SCREENABLE = ['solana', 'bsc', 'base'];

export async function runScreen(trigger = 'cron') {
  const state = await loadState();
  if (!Array.isArray(state.logs)) state.logs = [];
  if (!state.newTokenAlerts) state.newTokenAlerts = {};

  const summary = {
    trigger,
    at: new Date().toISOString(),
    enabled: state.screenEnabled !== false,
    dedup: alertStoreEnabled() ? 'upstash-redis' : 'state-lokal (/tmp, best-effort)',
    seen: 0, // pair baru yang diambil dari GeckoTerminal
    evaluated: 0, // token yang dievaluasi kill-switch siklus ini
    screenedNew: 0, // sama dengan evaluated (diisi alertNewTokens)
    rejectedByRule: {}, // jumlah REJECT per kode alasan
    passed: 0, // token PASS yang di-alert ke Telegram
    alerts: [], // { symbol, chain } yang di-alert
    unsupported: [], // chain yang tidak dievaluasi + alasannya
    errors: [],
  };

  if (!summary.enabled) {
    summary.errors.push('screener dimatikan via /screen off');
    return summary;
  }

  // Budget evaluasi kill-switch per siklus: GoPlus gratis ~30 req/menit.
  // Budget PER CHAIN (bukan bersama) supaya satu chain tidak menghabiskan
  // semuanya — tiap chain dievaluasi ~4 token baru per siklus.
  const BUDGET_PER_CHAIN = 4;
  let firstChain = true;
  for (const chainId of CONFIG.enabledChains) {
    const chain = CHAINS[chainId];
    if (!chain) continue;
    if (!SCREENABLE.includes(chainId)) {
      // HyperEVM: tanpa GoPlus, kill-switch tidak bisa PASS (fail closed).
      // Dicatat saja — tidak dievaluasi, tidak menghabiskan budget.
      summary.unsupported.push({
        chain: chainId,
        reason: 'GoPlus tidak mendukung chain ini — data keamanan tidak tersedia, kill-switch selalu REJECT (fail closed)',
      });
      log(state, `SCREEN-SKIP ${chain.label}: tanpa data keamanan (unsupported-for-now)`);
      continue;
    }
    if (!firstChain) await sleep(1500); // jeda antar chain (limit GeckoTerminal)
    firstChain = false;
    try {
      const pairs = await latestPools(chain.gecko);
      summary.seen += pairs.length;
      const before = summary.screenedNew || 0;
      const budget = { left: BUDGET_PER_CHAIN };
      await alertNewTokens(chain, chainId, pairs, state, summary, budget);
      summary.evaluated += (summary.screenedNew || 0) - before;
    } catch (e) {
      summary.errors.push(`screen ${chainId}: ${e.message}`);
    }
  }

  // alertNewTokens sudah mengisi summary.alerts (semua chain) — hitung ulang
  // passed dari sana supaya konsisten bila ada chain yang dilewati.
  summary.passed = summary.alerts.length;
  await saveState(state);
  return summary;
}
