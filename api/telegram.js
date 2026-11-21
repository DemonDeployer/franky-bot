// Franky Bot — webhook Telegram (remote control + notifikasi).
// BotFather memberi token; token dan chat ID HANYA dari env vars Vercel
// (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID). Token tidak pernah ditulis ke
// log, chat, atau file.
//
// Setup (sekali saja, setelah file ini di-upload):
//   1. Isi TELEGRAM_BOT_TOKEN di Vercel, redeploy.
//   2. Buka https://<domain-kamu>/api/telegram?setup=1 — webhook terdaftar.
//   3. Kirim /start ke bot di Telegram; bot membalas dengan chat ID kamu.
//   4. Isi TELEGRAM_CHAT_ID dengan angka itu di Vercel, redeploy.
// Setelah itu hanya chat itu yang dilayani; chat lain diabaikan diam-diam.
//
// Perintah: /start /status /posisi /scan /stop /jalan /cek <alamat> [chain]
//   /stop menjeda auto-trade (cron tetap jalan tapi tidak beli/jual),
//   /jalan menyalakannya lagi. /scan menjalankan satu siklus penuh.
// Trading tetap jalan di server (cron Vercel); Telegram hanya remote-nya.
import { CONFIG } from '../lib/config.js';
import { loadState, saveState } from '../lib/store.js';
import { runCycle } from '../lib/engine.js';
import { checkCoin, CHAINS } from '../lib/check.js';

const API = (token) => `https://api.telegram.org/bot${token}`;

async function tg(method, token, body) {
  try {
    const res = await fetch(`${API(token)}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json().catch(() => ({}));
  } catch {
    return {};
  }
}

async function reply(token, chatId, text) {
  await tg('sendMessage', token, { chat_id: chatId, text });
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
function fmtPctId(x) {
  return x == null || isNaN(x) ? '-' : Number(x).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%';
}
function holdersLine(h) {
  if (!h) return '';
  const parts = [];
  if (h.holderCount) parts.push(`👥 ${Number(h.holderCount).toLocaleString('id-ID')} holder`);
  parts.push(h.holderCount >= 10 ? `10 teratas ${fmtPctId(h.top10Pct)}` : '10 teratas: data belum lengkap');
  parts.push(`dev ${fmtPctId(h.ownerPct)}`);
  if (h.lpBurnPct > 0) parts.push(`LP bakar ${fmtPctId(h.lpBurnPct)}`);
  else if (h.lpLockedPct > 0) parts.push(`LP terkunci ${fmtPctId(h.lpLockedPct)}`);
  else parts.push('LP bakar 0%');
  parts.push(`cetak: ${h.mintable ? 'ya' : 'tidak'}`);
  parts.push(`daftar hitam: ${h.blacklist ? 'ya' : 'tidak'}`);
  return parts.join(' · ');
}

const HELP = `🤖 Franky Bot — perintah:
/start — sapaan + status
/status — mode, posisi, PnL hari ini
/posisi — daftar posisi terbuka
/scan — jalankan satu siklus scan sekarang
/stop — jeda auto-trade (cron tetap jalan, tidak beli/jual)
/jalan — nyalakan lagi auto-trade
/cek <alamat> [chain] — cek koin (chain: bsc/solana/base, default bsc)
/screen — status screener token baru
/screen on — nyalakan screener (alert token baru yang lolos kill-switch)
/screen off — matikan screener`;

async function statusText() {
  const state = await loadState();
  const mode = CONFIG.dryRun ? 'KERTAS (tidak ada uang asli)' : 'LIVE (uang asli!)';
  return (
    `🤖 Franky Bot — ${mode}\n` +
    `Auto-trade: ${state.paused ? 'DIJEDA ⏸️' : 'JALAN ▶️'}\n` +
    `Screener token baru: ${state.screenEnabled === false ? 'MATI ⏸️ (/screen on untuk menyalakan)' : 'AKTIF ▶️ (alert hanya bila lolos kill-switch)'}\n` +
    `Posisi terbuka: ${state.positions.length}/${CONFIG.maxPositions}\n` +
    `Hari ini: PnL $${Number(state.daily.pnlUsd || 0).toFixed(2)} · beli ${state.daily.buys || 0}x`
  );
}

async function screenText() {
  const state = await loadState();
  const enabled = state.screenEnabled !== false;
  const evaluated = Object.keys(state.newTokenAlerts || {}).length;
  const recent = (state.logs || [])
    .filter((l) => String(l.msg || '').startsWith('ALERT BARU'))
    .slice(0, 3)
    .map((l) => `• ${l.msg}`);
  return (
    `🔍 Screener token baru: ${enabled ? 'AKTIF ▶️' : 'MATI ⏸️'}\n` +
    `Chain: solana, bsc, base (HyperEVM belum didukung GoPlus — tidak dievaluasi)\n` +
    `Token sudah dievaluasi (tercatat): ${evaluated}\n` +
    `Alert hanya bila PASS kill-switch (pajak ≤10%, LP terkunci/dibakar, top-10 ≤25%, bukan honeypot).\n` +
    (recent.length ? `Alert terakhir:\n${recent.join('\n')}` : 'Belum ada alert PASS yang tercatat.') +
    `\nPerintah: /screen on · /screen off`
  );
}

export default async function handler(req, res) {
  const token = CONFIG.telegram.token;

  // GET ?setup=1 — daftarkan webhook URL ini ke Telegram (sekali saja).
  if (req.method === 'GET' && String(req.query.setup || '') === '1') {
    if (!token) {
      return res.status(400).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN belum diisi di env vars' });
    }
    const url = `https://${req.headers.host}/api/telegram`;
    const out = await tg('setWebhook', token, { url });
    return res.status(200).json({ ok: Boolean(out.ok), webhook: url, telegram: out });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method tidak didukung' });
  }

  const update = req.body && typeof req.body === 'object' ? req.body : {};
  const msg = update.message || {};
  const chatId = msg.chat?.id;
  const text = String(msg.text || '').trim();
  if (!token || !chatId || !text) return res.status(200).json({ ok: true });

  // Bootstrap: chat ID belum diisi — balas dengan chat ID si pengirim.
  if (!CONFIG.telegram.chatId) {
    await reply(
      token,
      chatId,
      `Halo! Chat ID kamu: ${chatId}\n\nIsi TELEGRAM_CHAT_ID=${chatId} di Environment Variables (dashboard hosting), lalu redeploy. Setelah itu kirim /start lagi.`,
    );
    return res.status(200).json({ ok: true });
  }
  // Hanya chat Eva yang dilayani.
  if (String(chatId) !== String(CONFIG.telegram.chatId)) {
    return res.status(200).json({ ok: true });
  }

  const [cmd, ...args] = text.split(/\s+/);
  try {
    if (cmd === '/start') {
      await reply(token, chatId, `Halo, Eva! 👋\n\n${await statusText()}\n\n${HELP}`);
    } else if (cmd === '/status') {
      await reply(token, chatId, await statusText());
    } else if (cmd === '/posisi') {
      const state = await loadState();
      if (!state.positions.length) {
        await reply(token, chatId, 'Belum ada posisi terbuka.');
      } else {
        const lines = state.positions.map(
          (p) => `• ${p.symbol} (${p.chain}) @ ${fmtPrice(p.entryPriceUsd)} · $${p.entryUsd}${p.paper ? ' (kertas)' : ''}`,
        );
        await reply(token, chatId, `📊 Posisi terbuka (${state.positions.length}):\n${lines.join('\n')}`);
      }
    } else if (cmd === '/scan') {
      await reply(token, chatId, '⏳ Memindai…');
      const s = await runCycle('telegram');
      const lines = [`🤖 Scan selesai (${s.dryRun ? 'KERTAS' : 'LIVE'})`];
      for (const b of s.buys) lines.push(`🟢 Beli ${b.symbol} (${b.chain}) @ ${fmtPrice(b.price)}`);
      for (const x of s.sells) lines.push(`🔴 Jual ${x.symbol} (${x.reason})`);
      if (s.skipped.length) lines.push(`⏭️ Dilewati: ${s.skipped.join(', ')}`);
      if (s.errors.length) lines.push(`⚠️ Error: ${s.errors.slice(0, 3).join(' | ')}`);
      lines.push(`Dipindai: ${s.scanned} pool · kandidat: ${s.candidates}`);
      await reply(token, chatId, lines.join('\n'));
    } else if (cmd === '/stop') {
      const state = await loadState();
      state.paused = true;
      await saveState(state);
      await reply(token, chatId, '⏸️ Auto-trade DIJEDA. Cron tetap jalan tapi tidak akan beli/jual. Kirim /jalan untuk menyalakan lagi.');
    } else if (cmd === '/jalan') {
      const state = await loadState();
      state.paused = false;
      await saveState(state);
      await reply(token, chatId, '▶️ Auto-trade JALAN lagi.');
    } else if (cmd === '/screen') {
      const arg = String(args[0] || '').toLowerCase();
      if (arg === 'on' || arg === 'off') {
        const state = await loadState();
        state.screenEnabled = arg === 'on';
        await saveState(state);
        await reply(
          token,
          chatId,
          arg === 'on'
            ? '🔍 Screener token baru DINYALAKAN. Alert masuk bila ada token baru yang lolos kill-switch (PASS).'
            : '🔍 Screener token baru DIMATIKAN. Tidak ada alert token baru sampai /screen on.',
        );
      } else {
        await reply(token, chatId, await screenText());
      }
    } else if (cmd === '/cek') {
      const address = args[0] || '';
      const chain = String(args[1] || 'bsc').toLowerCase();
      if (!address) {
        await reply(token, chatId, 'Pakai: /cek <alamat kontrak> [chain]\nContoh: /cek 0xD0079025a9Bb66a7a1de991De2E4326FABA35729 bsc');
      } else if (!CHAINS[chain]) {
        await reply(token, chatId, 'Chain tidak dikenal. Pilih: solana / bsc / base.');
      } else {
        try {
          const d = await checkCoin(chain, address);
          const h = d.security && d.security.holders;
          const flags = d.flags.map((f) => f.label).join(' · ') || 'Tidak ada temuan';
          await reply(
            token,
            chatId,
            `🔍 ${d.token.symbol || '???'} — ${d.verdict}\n` +
              `${flags}\n` +
              (h ? `${holdersLine(h)}\n` : '') +
              `Harga: ${fmtPrice(d.pair.priceUsd)} · Likuiditas: ${fmtUsd(d.pair.liquidityUsd)} · FDV: ${fmtUsd(d.pair.fdv)}\n` +
              `Volume 1 jam: ${fmtUsd(d.pair.volumeH1)} · Beli/Jual 1 jam: ${d.pair.buysH1}/${d.pair.sellsH1}`,
          );
        } catch (e) {
          await reply(token, chatId, `Gagal mengecek: ${e.message}`);
        }
      }
    } else {
      await reply(token, chatId, HELP);
    }
  } catch (e) {
    await reply(token, chatId, `Error: ${e.message}`);
  }
  return res.status(200).json({ ok: true });
}
