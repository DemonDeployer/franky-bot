// Franky Bot — CORS untuk mirror statis DeployHQ.
// Dashboard di DeployHQ memanggil API Vercel ini dari origin lain.
// Auth memakai Bearer token di localStorage (tanpa cookie), jadi
// Access-Control-Allow-Origin: * sudah cukup; tidak perlu credentials.
export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
