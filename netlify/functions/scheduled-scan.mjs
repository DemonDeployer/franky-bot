// Franky Bot — Scheduled Function: siklus trading 1x sehari 00:00 UTC
// (sama seperti cron Vercel). Tugasnya hanya memicu background function,
// karena scheduled function dibatasi 30 detik sementara satu siklus bisa
// lebih lama. Background function yang menjalankan runCycle (limit 15 mnt).
import { schedule } from '@netlify/functions';

export const handler = schedule('0 0 * * *', async () => {
  const site = (process.env.URL || '').replace(/\/$/, '');
  const secret = process.env.CRON_SECRET || '';
  try {
    await fetch(
      `${site}/.netlify/functions/scan-background?job=scan&secret=${encodeURIComponent(secret)}`,
      { method: 'POST' },
    );
  } catch (e) {
    console.error('[scheduled-scan] gagal memicu background:', e.message);
  }
  return { statusCode: 200, body: 'ok' };
});
