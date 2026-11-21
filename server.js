// Franky Bot — server HTTP mandiri untuk Altare (dan tes lokal).
// Vercel memakai api/*.js sebagai serverless functions; Altare butuh proses
// panjang yang listen di $PORT. Server ini menyajikan public/ statis +
// meneruskan /api/* ke handler yang sama (adaptor req/res minimal).
//   PORT=3000 node server.js
//   Procfile: web: node server.js
// Jadwal (scan/screener) BUKAN di sini — Altare Jobs:
//   node scripts/scan-local.js    (siklus trading, tiap 5 menit)
//   node scripts/screen-local.js  (screener token baru, tiap 5 menit)

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Hanya endpoint ini yang diteruskan ke api/*.js (whitelist).
const API = new Set([
  'auth',
  'check',
  'config',
  'positions',
  'scan',
  'screen',
  'telegram',
  'trending',
]);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) return {}; // batasi 1 MB
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function adaptRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    const body = JSON.stringify(obj);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  };
  return res;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  // Cegah path traversal: file harus tetap di dalam public/.
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    if (ext === '.html') res.setHeader('Cache-Control', 'no-store');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', data.length);
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  }
}

async function serveApi(req, res, name, query) {
  let handler;
  try {
    handler = (await import(`./api/${name}.js`)).default;
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'handler tidak ditemukan: ' + name }));
    return;
  }
  req.query = query;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    req.body = await readBody(req);
  } else {
    req.body = {};
  }
  adaptRes(res);
  try {
    await handler(req, res);
  } catch (e) {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: e.message || 'error' }));
    }
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    if (pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname.startsWith('/api/')) {
      const name = pathname.slice(5).split('/')[0];
      if (!API.has(name)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'endpoint tidak dikenal' }));
        return;
      }
      await serveApi(req, res, name, query);
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (e) {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('error: ' + (e.message || 'unknown'));
    }
  } finally {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`,
    );
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Franky Bot jalan di 0.0.0.0:${PORT} (ALTARE=${process.env.ALTARE || ''})`);
});
