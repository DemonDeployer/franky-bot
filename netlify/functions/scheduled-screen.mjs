// Franky Bot — Scheduled Function: screener token baru 1x sehari 01:00 UTC
// (sama seperti cron Vercel). Tugasnya hanya memicu background function,
// karena scheduled function dibatasi 30 detik sementara satu siklus bisa
// lebih lama. Background function yang menjalankan runScreen (limit 15 mnt).
import { schedule } from '@netlify/functions';

export const handler = schedule('0 1 * * *', async () => {
  const site = (process.env.URL || '').replace(/\/$/, '');
  const secret = process.env.CRON_SECRET || '';
  try {
    await fetch(
      `${site}/.netlify/functions/scan-background?job=screen&secret=${encodeURIComponent(secret)}`,
      { method: 'POST' },
    );
  } catch (e) {
    console.error('[scheduled-screen] gagal memicu background:', e.message);
  }
  return { statusCode: 200, body: 'ok' };
});
