// Franky Bot — endpoint screener token baru (ALERT-ONLY).
// Dipanggil Vercel Cron 1x sehari (01:00 UTC; cron 5 menit butuh paket Pro —
// pakai pinger eksternal bila mau tiap 5 menit) atau manual dari
// dashboard. Menjalankan runScreen() saja: TIDAK ada trading, TIDAK ada
// beli/jual, TIDAK mengubah DRY_RUN.
// Akses: sama seperti /api/scan — lolos bila CRON_SECRET cocok, ATAU session
// Google valid. Bila CRON_SECRET dan ALLOWED_EMAIL sama-sama kosong,
// endpoint terbuka (mode lama).

import { CONFIG } from '../lib/config.js';
import { runScreen } from '../lib/screen.js';
import { sessionFromReq, authEnabled } from '../lib/auth.js';

export default async function handler(req, res) {
  const given =
    req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  const cronOk = Boolean(CONFIG.cronSecret) && given === CONFIG.cronSecret;
  const sessionOk = Boolean(sessionFromReq(req));
  if ((CONFIG.cronSecret || authEnabled()) && !cronOk && !sessionOk) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const summary = await runScreen(req.query.source || 'manual');
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
