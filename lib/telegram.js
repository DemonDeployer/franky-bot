// Franky Bot — notifikasi & perintah lewat Telegram.
// Token bot dan chat ID HANYA dari env vars Vercel (TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID). Bila salah satu kosong, semua fungsi di sini diam
// (no-op) supaya bot tetap jalan tanpa Telegram.
// Token tidak pernah ditulis ke log, chat, atau file.
import { CONFIG } from './config.js';

const API = (token) => `https://api.telegram.org/bot${token}`;

export function telegramEnabled() {
  return Boolean(CONFIG.telegram.token && CONFIG.telegram.chatId);
}

// Kirim satu pesan ke chat Eva. Tidak pernah throw — gagal kirim hanya
// mengembalikan false supaya siklus trading tidak ikut crash.
// `extra` opsional diteruskan ke sendMessage Telegram (mis. reply_markup
// untuk tombol inline). Token tidak pernah ditulis ke log.
export async function sendTelegram(text, extra = {}) {
  if (!telegramEnabled()) return false;
  try {
    const res = await fetch(`${API(CONFIG.telegram.token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.telegram.chatId, text, ...extra }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function fmtPrice(x) {
  const n = Number(x);
  if (!isFinite(n) || n <= 0) return '-';
  if (n < 0.01) return '$' + n.toFixed(6);
  return '$' + n.toFixed(4);
}

function fmtUsd(x) {
  const n = Number(x);
  if (!isFinite(n)) return '-';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + ' jt';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + ' rb';
  return '$' + n.toFixed(2);
}

// Explorer per chain untuk tombol "Kontrak". Chain yang belum dipetakan
// dengan pasti (mis. HyperEVM) tidak dapat tombol Kontrak — tombol Chart
// (DexScreener) tetap ada.
const EXPLORERS = {
  solana: (a) => `https://solscan.io/token/${a}`,
  bsc: (a) => `https://bscscan.com/token/${a}`,
  base: (a) => `https://basescan.org/token/${a}`,
};

// Alert token/pair BARU yang lolos Kill-Switch Filter
// (onchain-alpha-and-liquidity-hunter). Format kartu alert mengikuti
// telegram-and-webhook-bot-architect: risk badge, nama token + link
// explorer, metrik kunci, tombol aksi (Chart, Kontrak).
// ALERT-ONLY: tidak beli/jual, tidak memicu trade apa pun. Lolos
// kill-switch BUKAN rekomendasi beli — itu dinyatakan di pesan.
export async function notifyNewToken(d) {
  const explorer = EXPLORERS[d.chainId]?.(d.tokenAddress) || null;
  const chartUrl = `https://dexscreener.com/${d.dexSlug || d.chainId}/${d.pairAddress}`;
  const lp =
    Number(d.lpBurnPct || 0) > 0
      ? `dibakar ${d.lpBurnPct}%`
      : Number(d.lpLockedPct || 0) > 0
        ? `terkunci ${d.lpLockedPct}%`
        : 'belum diamankan';
  const lines = [
    `🟢 [SAFE] TOKEN BARU — ${d.symbol} (${d.chainLabel})`,
    d.name && d.name !== d.symbol ? d.name : '',
    `Likuiditas: ${fmtUsd(d.liquidityUsd)} · FDV: ${fmtUsd(d.fdvUsd)}`,
    `Pajak beli ${d.buyTax}% / jual ${d.sellTax}% · Top 10: ${d.top10Pct}%`,
    `LP: ${lp}`,
    d.ageMin != null ? `Umur pair: ${d.ageMin} mnt · Vol 1j: ${fmtUsd(d.volumeH1)}` : '',
    `Kontrak: ${d.tokenAddress}`,
    explorer ? `Explorer: ${explorer}` : '',
    `Chart: ${chartUrl}`,
    `⚠️ Lolos kill-switch ≠ rekomendasi beli. DYOR — screening hanya menilai struktur kontrak & likuiditas.`,
  ].filter(Boolean);
  const buttons = [{ text: '📊 Chart', url: chartUrl }];
  if (explorer) buttons.push({ text: '📄 Kontrak', url: explorer });
  await sendTelegram(lines.join('\n'), {
    reply_markup: { inline_keyboard: [buttons] },
  });
}

export async function notifyBuy(pos) {
  const tag = pos.paper ? 'KERTAS' : 'LIVE';
  await sendTelegram(
    `🟢 BELI (${tag}) ${pos.symbol} (${pos.chain})\n` +
      `Harga: ${fmtPrice(pos.entryPriceUsd)} · Jumlah: $${pos.entryUsd}` +
      (pos.txHash ? `\nTx: ${pos.txHash}` : ''),
  );
}

export async function notifySell(trade) {
  const tag = trade.paper ? 'KERTAS' : 'LIVE';
  const pnl = Number(trade.pnlPct || 0);
  await sendTelegram(
    `🔴 JUAL (${tag}) ${trade.symbol} (${trade.reason})\n` +
      `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% ($${Number(trade.pnlUsd || 0).toFixed(2)})`,
  );
}
