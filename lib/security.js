// Franky Bot — cek keamanan token via GoPlus API (gratis, tanpa key).
// Prinsip: kalau tidak ada data atau ada tanda bahaya, SKIP (fail closed).
// Docs: https://gopluslabs.io/token-security-api

import { CONFIG } from './config.js';

const API = 'https://api.gopluslabs.io/api/v1';

// GoPlus mengembalikan `percent` sebagai fraksi 0-1 (mis. 0.1166 = 11,66%),
// bukan satuan persen. Normalisasi: bila nilai mentah > 1, anggap sudah persen.
function toPct(v) {
  const n = Number(v || 0);
  if (!isFinite(n)) return 0;
  return n > 1 ? n : n * 100;
}

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

// Statistik holder dari data GoPlus. Alamat pair (pool likuiditas) dan alamat
// burn dikeluarkan dari hitungan 10 teratas, karena pool/burn bukan risiko dump.
function holderStats(info, excludeAddresses) {
  const excluded = new Set((excludeAddresses || []).map((a) => String(a).toLowerCase()));
  const holders = (info.holders || []).filter((h) => {
    const addr = String(h.address || '').toLowerCase();
    return !excluded.has(addr) && !BURN_ADDRESSES.has(addr);
  });
  const top10Pct = holders.slice(0, 10).reduce((s, h) => s + toPct(h.percent), 0);
  let lpBurnPct = 0;
  let lpLockedPct = 0;
  for (const x of info.lp_holders || []) {
    const addr = String(x.address || '').toLowerCase();
    const pct = toPct(x.percent);
    if (BURN_ADDRESSES.has(addr)) lpBurnPct += pct;
    else if (String(x.is_locked) === '1') lpLockedPct += pct;
  }
  return {
    top10Pct: +top10Pct.toFixed(1),
    holderCount: Number(info.holder_count || 0),
    ownerPct: +toPct(info.owner_percent).toFixed(1),
    lpBurnPct: +lpBurnPct.toFixed(1),
    lpLockedPct: +lpLockedPct.toFixed(1),
    mintable: info.is_mintable === '1',
    blacklist: info.is_blacklisted === '1',
  };
}

// Selector 4-byte fungsi setter pajak yang umum (dihitung sekali dari
// nama fungsi via ethers.id — TIDAK butuh import ethers di runtime, karena
// import statis library berat membuat cold start Vercel crash).
// Bila bytecode kontrak mengandung salah satu selector ini, pemilik kontrak
// bisa mengubah pajak kapan saja — kill-switch menolaknya (TAX_SETTER).
// Daftar ini heuristik (nama fungsi bisa apa saja), jadi hasil "tidak ada"
// BUKAN jaminan tidak ada setter lain — hanya setter bernama umum yang dicek.
const TAX_SETTER_SELECTORS = new Set([
  '0x2e5bb6ff', // setTax(uint256)
  '0xdc1052e2', // setBuyTax(uint256)
  '0x8cd09d50', // setSellTax(uint256)
  '0xc647b20e', // setTaxes(uint256,uint256)
  '0xaa35822c', // setBuyTaxes(uint256,uint256)
  '0xa11a1682', // setSellTaxes(uint256,uint256)
  '0xcca0feb6', // updateTax(uint256)
  '0x436d3340', // updateBuyTax(uint256)
  '0x12185a39', // updateSellTax(uint256)
  '0x69fe0e2d', // setFee(uint256)
  '0x0b78f9c0', // setFees(uint256,uint256)
  '0xc4081a4c', // setTaxFee(uint256)
  '0x061c82d0', // setTaxFeePercent(uint256)
  '0x0cc835a3', // setBuyFee(uint256)
  '0x8b4cee08', // setSellFee(uint256)
  '0xc3b240b6', // setTradingTax(uint256)
]);

// true = bytecode mengandung setter pajak bernama umum; false = tidak ada;
// null = tidak bisa diperiksa (bukan EVM / RPC gagal / tanpa bytecode).
// Kontrak proxy tidak terdeteksi di sini (bytecode proxy minimal) —
// proxy + mintable sudah ditolak kill-switch secara terpisah.
async function detectTaxSetter(rpcUrl, address) {
  if (!rpcUrl) return null;
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const code = String(j?.result || '');
    if (!code || code === '0x') return null;
    const lower = code.toLowerCase();
    for (const sel of TAX_SETTER_SELECTORS) {
      if (lower.includes(sel.slice(2))) return true;
    }
    return false;
  } catch {
    return null;
  }
}

export async function checkToken(goplusChainId, address, excludeAddresses) {
  // Solana (101): GoPlus tidak mendukung chain ini (code 2022), jadi gate
  // bot memakai RugCheck — sama seperti yang sudah dipakai Franky Check.
  // Tanpa cabang ini, semua kandidat Solana selalu di-skip diam-diam.
  if (String(goplusChainId) === '101') return checkTokenSolana(address, excludeAddresses);
  if (!goplusChainId) return { ok: false, reason: 'goplus-tidak-dukung-chain' };
  const url = `${API}/token_security/${goplusChainId}?contract_addresses=${address}`;
  const res = await fetch(url);
  if (!res.ok) return { ok: false, reason: `goplus-http-${res.status}` };
  const data = await res.json();
  // Kunci hasil GoPlus: alamat EVM dalam huruf kecil, alamat Solana apa adanya
  // (base58, case-sensitive) — jadi coba keduanya.
  const info = data?.result?.[address] || data?.result?.[address.toLowerCase()];
  if (!info) return { ok: false, reason: 'goplus-tidak-ada-data' };

  if (info.is_honeypot === '1') return { ok: false, reason: 'honeypot' };
  if (info.is_proxy === '1' && info.is_mintable === '1') {
    return { ok: false, reason: 'proxy-dan-mintable' };
  }
  const buyTax = Number(info.buy_tax || 0);
  const sellTax = Number(info.sell_tax || 0);
  if (buyTax > CONFIG.maxTaxPct || sellTax > CONFIG.maxTaxPct) {
    return { ok: false, reason: `pajak-tinggi buy ${buyTax}% sell ${sellTax}%` };
  }
  if (info.is_mintable === '1') return { ok: false, reason: 'mintable' };
  if (info.is_blacklisted === '1') return { ok: false, reason: 'blacklist' };
  const ownerPct = Number(info.owner_percent || 0);
  if (ownerPct > 20) return { ok: false, reason: `owner-pegang-${ownerPct}%` };

  return { ok: true, buyTax, sellTax, honeypot: false, holders: holderStats(info, excludeAddresses) };
}

// Gate trading untuk Solana via RugCheck — cerminan aturan gate EVM di
// checkToken, dengan sumber data yang berbeda:
//   rugged (d.rugged)          -> honeypot di EVM
//   mintAuthority != null      -> mintable di EVM
//   freezeAuthority != null    -> blacklist di EVM
//   creator memegang > 20%     -> ownerPct > 20 di EVM
// Solana tidak punya buy/sell tax, jadi keduanya 0. Fail closed: bila
// RugCheck tidak menjawab atau mint tidak cocok, kandidat di-skip.
async function checkTokenSolana(mint, excludeAddresses) {
  const sec = await fetchSecuritySolana(mint);
  if (!sec) return { ok: false, reason: 'rugcheck-tidak-ada-data' };
  if (sec.rugged) return { ok: false, reason: 'rugged' };
  if (sec.holders.mintable) return { ok: false, reason: 'mintable' };
  if (sec.holders.blacklist) return { ok: false, reason: 'blacklist' };
  if (sec.holders.ownerPct > 20) {
    return { ok: false, reason: `owner-pegang-${sec.holders.ownerPct}%` };
  }
  return { ok: true, buyTax: 0, sellTax: 0, honeypot: false, holders: sec.holders };
}

// Data keamanan mentah untuk pemeriksa koin (Franky Check): tanpa gate
// trading — semua temuan dikembalikan apa adanya supaya vonis bisa menilai
// sendiri (mintable, pajak tinggi, blacklist, owner besar justru jadi label
// di hasil cek, bukan alasan menghentikan pengecekan).
// GoPlus hanya mendukung chain EVM: untuk Solana (101) dipakai RugCheck,
// karena GoPlus mengembalikan code 2022 "main chain is not supported".
// rpcUrl opsional: bila diisi (EVM), bytecode ikut diperiksa apakah ada
// setter pajak (taxSetter: true/false/null bila tidak bisa diperiksa).
export async function fetchSecurity(goplusChainId, address, excludeAddresses, rpcUrl) {
  if (String(goplusChainId) === '101') return fetchSecuritySolana(address);
  if (!goplusChainId) return null;
  const url = `${API}/token_security/${goplusChainId}?contract_addresses=${address}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const info = data?.result?.[address] || data?.result?.[address.toLowerCase()];
  if (!info) return null;
  return {
    honeypot: info.is_honeypot === '1',
    proxy: info.is_proxy === '1',
    buyTax: Number(info.buy_tax || 0),
    sellTax: Number(info.sell_tax || 0),
    taxSetter: await detectTaxSetter(rpcUrl, address),
    holders: holderStats(info, excludeAddresses),
  };
}

async function fetchSecuritySolana(mint) {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
  if (!res.ok) return null;
  const d = await res.json();
  if (!d || d.mint !== mint) return null;
  const top = (d.topHolders || []).slice(0, 10);
  const top10Pct = top.reduce((s, h) => s + Number(h.pct || 0), 0);
  const creatorTop = (d.topHolders || []).find((h) => h.address === d.creator);
  let lpLockedPct = 0;
  for (const m of d.markets || []) {
    lpLockedPct = Math.max(lpLockedPct, Number(m?.lp?.lpLockedPct || 0));
  }
  return {
    honeypot: d.rugged === true,
    rugged: d.rugged === true,
    buyTax: 0,
    sellTax: 0,
    taxSetter: false, // Solana tidak punya konsep pajak beli/jual.
    holders: {
      top10Pct: +top10Pct.toFixed(1),
      holderCount: Number(d.totalHolders || 0),
      ownerPct: creatorTop ? +Number(creatorTop.pct || 0).toFixed(1) : 0,
      lpBurnPct: 0,
      lpLockedPct: +lpLockedPct.toFixed(1),
      mintable: d.mintAuthority != null,
      blacklist: d.freezeAuthority != null,
    },
    risks: (d.risks || []).map((r) => r.name || String(r)),
    score: d.score_normalised ?? null,
  };
}
