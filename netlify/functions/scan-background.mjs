// Franky Bot — background function untuk siklus trading/screener di Netlify.
// Nama file berakhiran -background: Netlify menjalankannya asinkron
// (limit 15 menit) dan langsung membalas 202 ke pemanggil.
// Dipicu oleh Scheduled Functions (scheduled-scan/screen) dengan
// ?job=scan|screen + secret CRON_SECRET yang sama seperti /api/scan.
// Satu siklus bisa lebih dari 30 detik (batas scheduled function), jadi
// JANGAN jalankan runCycle/runScreen langsung di scheduled function.
import { runCycle } from '../../lib/engine.js';
import { runScreen } from '../../lib/screen.js';
import { CONFIG } from '../../lib/config.js';

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    headers[String(k).toLowerCase()] = v;
  }
  const given = q.secret || String(headers.authorization || '').replace('Bearer ', '');
  if (CONFIG.cronSecret && given !== CONFIG.cronSecret) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: 'unauthorized' }),
    };
  }
  const job = String(q.job || 'scan').toLowerCase();
  try {
    const summary =
      job === 'screen' ? await runScreen('netlify-cron') : await runCycle('netlify-cron');
    console.log(`[background:${job}] selesai`, JSON.stringify(summary).slice(0, 500));
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: true, job, started: true }),
    };
  } catch (e) {
    console.error(`[background:${job}] error`, e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, job, error: e.message || 'error' }),
    };
  }
};
