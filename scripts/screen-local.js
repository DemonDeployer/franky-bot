// Franky Bot — jalankan satu siklus SCREENER token baru dari terminal (tes lokal).
//   npm install
//   npm run screen
// ALERT-ONLY: tidak ada trading, tidak ada beli/jual, DRY_RUN tidak disentuh.
// Tanpa TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID di env, tidak ada pesan yang
// terkirim — ringkasan di bawah ini yang menunjukkan apa yang AKAN di-alert.

import { runScreen } from '../lib/screen.js';

const s = await runScreen('local');
console.log(JSON.stringify(s, null, 2));
console.log(
  `\nRINGKASAN: dilihat ${s.seen} pair · dievaluasi ${s.evaluated} · ` +
    `REJECT ${JSON.stringify(s.rejectedByRule)} · PASS (di-alert) ${s.passed}`,
);
if (s.alerts.length) {
  console.log('ALERT YANG AKAN DIKIRIM:');
  for (const a of s.alerts) console.log(`  - ${a.symbol} (${a.chain})`);
}
if (s.unsupported.length) {
  console.log('TIDAK DIEVALUASI:');
  for (const u of s.unsupported) console.log(`  - ${u.chain}: ${u.reason}`);
}
