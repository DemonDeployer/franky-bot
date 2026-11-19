// Franky Check — logika vonis pemeriksa koin, dipakai api/check.js.
// Vonis murni dari angka on-chain (DexScreener + GoPlus): harga, likuiditas,
// pajak, honeypot, konsentrasi holder, LP. Bukan analisis insider GMGN dan
// bukan penilaian "apakah ceritanya nyata" — itu butuh membaca X/website.

import { fetchSecurity } from './security.js';

export const CHAINS = {
  solana: { label: 'Solana', goplus: '101', gecko: 'solana', dex: 'solana' },
  bsc: { label: 'BNB Chain', goplus: '56', gecko: 'bsc', dex: 'bsc' },
  base: { label: 'Base', goplus: '8453', gecko: 'base', dex: 'base' },
  // Elysium: harga/likuiditas dari DexScreener + GeckoTerminal jalan, tapi
  // GoPlus TIDAK mendukung chain ini (code 2022) — cek Elysium selalu
  // membawa peringatan NO_SEC (data keamanan tidak tersedia), jadi vonis
  // minimal WASPADA. Jangan pernah menampilkan Elysium sebagai AMAN penuh.
  elysium: { label: 'Elysium', goplus: null, gecko: 'elysium', dex: 'elysium' },
  // Robinhood Chain (Arbitrum Orbit L2, chainId 4663): GoPlus mendukung
  // (code 1), jadi cek Robinhood dapat data keamanan penuh seperti BSC/Base.
  robinhood: { label: 'Robinhood', goplus: '4663', gecko: 'robinhood', dex: 'robinhood' },
  // HyperEVM (chainId 999): GoPlus TIDAK mendukung (code 2022) — sama
  // seperti Elysium, cek HyperEVM selalu membawa peringatan NO_SEC dan
  // vonis minimal WASPADA.
  hyperliquid: { label: 'HyperEVM', goplus: null, gecko: 'hyperevm', dex: 'hyperevm' },
  // Ethereum mainnet (chainId 1): GoPlus mendukung penuh (code 1).
  // Perhatikan: id GeckoTerminal-nya "eth", bukan "ethereum".
  ethereum: { label: 'Ethereum', goplus: '1', gecko: 'eth', dex: 'ethereum' },
};

export function isEvmAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());
}

export function isSolanaAddress(a) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || '').trim());
}

// pair: data pair DexScreener yang sudah dipilih (likuiditas terbesar).
// sec: hasil lib/security.js fetchSecurity (atau null bila GoPlus tanpa data).
// Mengembalikan { verdict: 'AMAN'|'WASPADA'|'BERBAHAYA', flags: [{code,label,level,detail}] }.
// `detail` menjelaskan aturan ambangnya dalam bahasa Indonesia supaya user
// tahu persis kenapa vonisnya begitu — tampilkan di kartu hasil.
export function verdictFor(pair, sec) {
  const flags = [];
  const push = (code, label, level, detail) => flags.push({ code, label, level, detail });

  if (!sec) {
    push('NO_SEC', 'Data keamanan tidak tersedia', 'warn', 'GoPlus/RugCheck tidak mendukung chain ini, jadi honeypot, pajak, dan holder tidak bisa diverifikasi — vonis tidak bisa AMAN.');
  } else {
    if (sec.honeypot) push('HONEYPOT', 'HONEYPOT', 'danger', 'Kontrak terdeteksi honeypot: token bisa dibeli tapi tidak bisa dijual kembali.');
    if (sec.rugged) push('RUGGED', 'RUG PULL TERDETEKSI', 'danger', 'Pola rug pull terdeteksi pada kontrak ini.');
    const tax = Math.max(Number(sec.buyTax || 0), Number(sec.sellTax || 0));
    if (tax > 20) push('TAX_HIGH', `PAJAK ${tax}%`, 'danger', `Pajak beli/jual ${tax}% — ambang bahaya di atas 20%.`);
    else if (tax > 5) push('TAX', `Pajak beli ${sec.buyTax}% / jual ${sec.sellTax}%`, 'warn', `Pajak beli ${sec.buyTax}% / jual ${sec.sellTax}% — ambang waspada di atas 5%, bahaya di atas 20%.`);
    const h = sec.holders || {};
    const top10 = Number(h.top10Pct || 0);
    const dev = Number(h.ownerPct || 0);
    if (top10 >= 30) push('DUMP_RISK', 'DUMP RISK', 'danger', `10 holder teratas memegang ${top10}% dari suplai — ambang bahaya 30%. Satu jualan besar bisa menjatuhkan harga.`);
    else if (top10 >= 20) push('TOP10', `10 teratas ${top10}%`, 'warn', `10 holder teratas memegang ${top10}% dari suplai — ambang waspada 20%, bahaya 30%.`);
    if (dev >= 10) push('DEV', `DEV PEGANG ${dev}%`, 'danger', `Developer/owner memegang ${dev}% dari suplai — ambang bahaya 10%.`);
    else if (dev >= 5) push('DEV', `Dev pegang ${dev}%`, 'warn', `Developer/owner memegang ${dev}% dari suplai — ambang waspada 5%, bahaya 10%.`);
    if (Number(h.lpBurnPct || 0) === 0 && Number(h.lpLockedPct || 0) === 0) {
      push('LP_OPEN', 'LP BELUM DIAMANKAN', 'warn', 'Likuiditas tidak dibakar dan tidak dikunci — pemilik pool bisa menariknya kapan saja.');
    }
    if (h.mintable) push('MINTABLE', 'BISA DICETAK', 'warn', 'Suplai token masih bisa dicetak oleh pemilik kontrak — nilaimu bisa terdilusi.');
    if (h.blacklist) push('BLACKLIST', 'ADA DAFTAR HITAM', 'danger', 'Kontrak punya fungsi daftar hitam — alamat bisa diblokir dari jual/beli.');
  }

  if (pair) {
    const liq = Number(pair?.liquidity?.usd || 0);
    if (liq > 0 && liq < 10000) push('LIQ_LOW', 'Likuiditas tipis', 'warn', `Likuiditas hanya $${liq.toLocaleString('id-ID')} — di bawah $10.000, harga gampang digerakkan dan susah jual dalam jumlah besar.`);
    const h1 = Number(pair?.priceChange?.h1 ?? 0);
    if (h1 <= -50) push('DUMPED', 'Turun >50% dalam 1 jam', 'warn', `Harga turun ${h1}% dalam 1 jam terakhir — tren sedang jatuh.`);
  }

  const danger = flags.some((f) => f.level === 'danger');
  const warn = flags.some((f) => f.level === 'warn');
  const verdict = danger ? 'BERBAHAYA' : warn ? 'WASPADA' : 'AMAN';
  return { verdict, flags };
}

// Kill-Switch Filter — onchain-alpha-and-liquidity-hunter (Step 1 + Step 2).
// Gate KHUSUS alert Telegram token baru. Terpisah dari verdictFor/checkCoin:
// ambangnya mengikuti skill, BUKAN ambang check.html. Jangan dipakai untuk
// keputusan beli/jual.
//   pair: data pair DexScreener/GeckoTerminal (likuiditas, fdv).
//   sec: hasil fetchSecurity (atau null bila tidak ada data keamanan).
// Mengembalikan { pass, verdict: 'PASS'|'REJECT', reasons: [{code,label,detail}], checks }.
//   reasons: daftar alasan REJECT (kosong bila PASS), bahasa Indonesia.
//   checks: nilai tiap pemeriksaan. Data yang tidak tersedia dari sumber
//     saat ini dicatat 'tidak-terverifikasi' dan TIDAK PERNAH jadi alasan
//     REJECT: wash trading (DexScreener hanya memberi jumlah tx, bukan
//     jumlah wallet unik) dan smart-money flow (tidak ada sumber wallet
//     berlabel) — keduanya dari Step 2/Step 3 skill.
// Ambang REJECT (skill):
//   honeypot/rugged | buy/sell tax > 10% | top10 non-LP/non-burn > 25% |
//   LP tidak dibakar DAN tidak dikunci | mintable | blacklist |
//   proxy + mintable | FDV > $1 jt dengan likuiditas < $10 rb |
//   data keamanan/pair tidak tersedia (fail closed).
export function killSwitchFor(pair, sec) {
  const reasons = [];
  const checks = { washTrading: 'tidak-terverifikasi', smartMoney: 'tidak-terverifikasi' };
  const push = (code, label, detail) => reasons.push({ code, label, detail });

  if (!pair) {
    push('NO_PAIR', 'DATA PAIR TIDAK TERSEDIA', 'Tidak ada data likuiditas/FDV — token tidak bisa dinilai, jadi tidak di-alert.');
    return { pass: false, verdict: 'REJECT', reasons, checks };
  }
  if (!sec) {
    push('NO_SEC', 'DATA KEAMANAN TIDAK TERSEDIA', 'GoPlus/RugCheck tidak mendukung chain ini atau tidak menjawab — honeypot, pajak, dan holder tidak bisa diverifikasi, jadi tidak di-alert (fail closed).');
    return { pass: false, verdict: 'REJECT', reasons, checks };
  }

  const liq = Number(pair?.liquidity?.usd || 0);
  const fdv = Number(pair?.fdv || 0);
  checks.liquidityUsd = liq;
  checks.fdvUsd = fdv;

  // Step 1 — Kill-Switch Filter.
  if (sec.honeypot || sec.rugged) {
    push('HONEYPOT', 'HONEYPOT / RUG', 'Kontrak terdeteksi honeypot atau rug pull.');
  }
  const buyTax = Number(sec.buyTax || 0);
  const sellTax = Number(sec.sellTax || 0);
  checks.buyTax = buyTax;
  checks.sellTax = sellTax;
  const tax = Math.max(buyTax, sellTax);
  if (tax > 10) {
    push('TAX_HIGH', `PAJAK ${tax}%`, `Pajak beli ${buyTax}% / jual ${sellTax}% — ambang kill-switch di atas 10%.`);
  }
  // holderStats sudah mengeluarkan alamat pair (LP) dan burn dari top10,
  // jadi top10Pct di sini = 10 holder teratas non-LP/non-burn (sesuai skill).
  const h = sec.holders || {};
  const top10 = Number(h.top10Pct || 0);
  checks.top10Pct = top10;
  if (top10 > 25) {
    push('TOP10', `10 TERATAS ${top10}%`, `10 holder teratas (di luar LP/burn) memegang ${top10}% dari suplai — ambang kill-switch 25%.`);
  }
  const lpBurn = Number(h.lpBurnPct || 0);
  const lpLocked = Number(h.lpLockedPct || 0);
  checks.lpBurnPct = lpBurn;
  checks.lpLockedPct = lpLocked;
  if (lpBurn === 0 && lpLocked === 0) {
    push('LP_OPEN', 'LP BELUM DIAMANKAN', 'Likuiditas tidak dibakar dan tidak dikunci — pemilik pool bisa menariknya kapan saja.');
  }
  checks.mintable = !!h.mintable;
  if (h.mintable) {
    push('MINTABLE', 'BISA DICETAK', 'Suplai token masih bisa dicetak oleh pemilik kontrak.');
  }
  checks.blacklist = !!h.blacklist;
  if (h.blacklist) {
    push('BLACKLIST', 'ADA DAFTAR HITAM', 'Kontrak punya fungsi daftar hitam — alamat bisa diblokir dari jual/beli.');
  }
  checks.proxy = !!sec.proxy;
  if (sec.proxy && h.mintable) {
    push('PROXY_MINT', 'PROXY + MINTABLE', 'Kontrak proxy yang logikanya bisa diganti dan suplainya bisa dicetak.');
  }

  // Step 2 — Kualitas likuiditas: FDV besar tapi likuiditas tipis.
  if (fdv > 1000000 && liq < 10000) {
    push(
      'FDV_LIQ',
      'FDV BESAR, LIKUIDITAS TIPIS',
      `FDV $${fdv.toLocaleString('id-ID')} tapi likuiditas hanya $${liq.toLocaleString('id-ID')} — ambang kill-switch: FDV di atas $1 jt dengan likuiditas di bawah $10 rb.`,
    );
  }

  const pass = reasons.length === 0;
  return { pass, verdict: pass ? 'PASS' : 'REJECT', reasons, checks };
}

// Cek satu koin sampai tuntas (dipakai api/check.js dan perintah /cek di
// Telegram). Melempar Error bila chain/alamat tidak valid, token tidak
// ditemukan, atau DexScreener gagal — pemanggil yang menentukan status HTTP.
export async function checkCoin(chain, address) {
  const meta = CHAINS[chain];
  if (!meta) throw new Error('chain tidak dikenal (solana / bsc / base / elysium / robinhood / hyperevm / ethereum)');
  address = String(address || '').trim();
  if (chain === 'solana' ? !isSolanaAddress(address) : !isEvmAddress(address)) {
    throw new Error('alamat token tidak valid untuk chain ini');
  }
  const dexRes = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${address}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!dexRes.ok) throw new Error(`DexScreener HTTP ${dexRes.status}`);
  const dex = await dexRes.json();
  const pairs = (Array.isArray(dex.pairs) ? dex.pairs : []).filter(
    (p) => String(p.chainId || '').toLowerCase() === meta.dex,
  );
  if (!pairs.length) {
    throw new Error('token tidak ditemukan / belum ada pair di chain ini');
  }
  pairs.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
  const p = pairs[0];

  let sec = null;
  try {
    sec = await fetchSecurity(meta.goplus, address, [p.pairAddress]);
  } catch {
    sec = null; // GoPlus/RugCheck gagal: vonis tetap jalan dengan peringatan NO_SEC
  }

  const { verdict, flags } = verdictFor(p, sec);
  const createdAt = Number(p.pairCreatedAt || 0);
  return {
    chain,
    address,
    checkedAt: new Date().toISOString(),
    token: {
      name: p.baseToken?.name || '',
      symbol: p.baseToken?.symbol || '',
      image: p.info?.imageUrl || '',
    },
    pair: {
      dex: p.dexId || '',
      pairAddress: p.pairAddress || '',
      priceUsd: p.priceUsd || '',
      liquidityUsd: Number(p?.liquidity?.usd || 0),
      fdv: Number(p.fdv || 0),
      marketCap: Number(p.marketCap || 0),
      volumeH1: Number(p?.volume?.h1 || 0),
      buysH1: Number(p?.txns?.h1?.buys || 0),
      sellsH1: Number(p?.txns?.h1?.sells || 0),
      changeH1: Number(p?.priceChange?.h1 ?? 0),
      changeH24: Number(p?.priceChange?.h24 ?? 0),
      createdAt,
      ageMin: createdAt ? Math.max(0, Math.round((Date.now() - createdAt) / 60000)) : null,
    },
    security: sec
      ? { honeypot: sec.honeypot, buyTax: sec.buyTax, sellTax: sec.sellTax, holders: sec.holders || null, risks: sec.risks || null, score: sec.score ?? null }
      : null,
    verdict,
    flags,
  };
}
