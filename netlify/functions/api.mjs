// Franky Bot — router Netlify Functions untuk api/*.js (gaya Vercel).
// Netlify tidak memakai folder api/ seperti Vercel; redirect di netlify.toml
// mengarahkan /api/<nama> ke function ini, lalu diteruskan ke handler yang
// sama dengan adaptor req/res minimal (pola yang sama seperti server.js
// untuk Altare). Import dibuat STATIS supaya bundler Netlify ikut
// menyertakan semua handler + lib yang mereka pakai.
import authHandler from '../../api/auth.js';
import checkHandler from '../../api/check.js';
import configHandler from '../../api/config.js';
import positionsHandler from '../../api/positions.js';
import scanHandler from '../../api/scan.js';
import screenHandler from '../../api/screen.js';
import telegramHandler from '../../api/telegram.js';
import trendingHandler from '../../api/trending.js';

const HANDLERS = {
  auth: authHandler,
  check: checkHandler,
  config: configHandler,
  positions: positionsHandler,
  scan: scanHandler,
  screen: screenHandler,
  telegram: telegramHandler,
  trending: trendingHandler,
};

function endpointName(event) {
  const raw = String(event.rawUrl || '');
  let m = raw.match(/\/api\/([A-Za-z0-9-]+)/);
  if (m) return m[1];
  m = String(event.path || '').match(/\/api\/([A-Za-z0-9-]+)/);
  if (m) return m[1];
  const parts = String(event.path || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function parseBody(event) {
  if (!event.body) return {};
  let text = event.body;
  if (event.isBase64Encoded) {
    try {
      text = Buffer.from(text, 'base64').toString('utf8');
    } catch {
      return {};
    }
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const handler = async (event) => {
  const name = endpointName(event);
  const run = HANDLERS[name];
  if (!run) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: 'endpoint tidak dikenal' }),
    };
  }
  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) {
    headers[String(k).toLowerCase()] = v;
  }
  const req = {
    method: event.httpMethod || 'GET',
    headers,
    query: event.queryStringParameters || {},
    body: ['POST', 'PUT', 'PATCH'].includes(event.httpMethod) ? parseBody(event) : {},
  };
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(obj) {
      payload = JSON.stringify(obj);
      return res;
    },
    setHeader() {
      return res;
    },
    send(b) {
      payload = typeof b === 'string' ? b : JSON.stringify(b);
      return res;
    },
  };
  try {
    await run(req, res);
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: e.message || 'error' }),
    };
  }
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: payload ?? '{}',
  };
};
