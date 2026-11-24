// Franky Bot — konfigurasi publik untuk dashboard.
// GOOGLE_CLIENT_ID boleh tampil di browser (itu memang dirancang publik);
// ALLOWED_EMAIL dan SESSION_SECRET TIDAK PERNAH dikirim ke sini.
// signupEnabled = pendaftaran akun paper aktif (Upstash Redis terisi).
import { applyCors } from '../lib/cors.js';
import { accountsEnabled } from '../lib/accounts.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  return res.status(200).json({
    ok: true,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    authEnabled: Boolean(process.env.ALLOWED_EMAIL),
    signupEnabled: accountsEnabled(),
  });
}
