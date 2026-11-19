// Franky Check — endpoint pemeriksa koin (read-only, tanpa login).
// GET /api/check?chain=bsc&address=0x...  atau POST {chain, address}.
// Logika ceknya tinggal di lib/check.js (checkCoin); file ini hanya
// membungkusnya jadi HTTP. Terbuka seperti "first check needs no account":
// tidak ada wallet, kunci, atau uang yang terlibat — hanya membaca data publik.
import { checkCoin } from '../lib/check.js';

export default async function handler(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const chain = String(req.query.chain || body.chain || 'bsc').toLowerCase();
  const address = String(req.query.address || body.address || '').trim();
  try {
    const result = await checkCoin(chain, address);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    const msg = e.message || 'gagal mengecek';
    const status = /tidak dikenal|tidak valid/.test(msg)
      ? 400
      : /tidak ditemukan/.test(msg)
        ? 404
        : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
}
