DITERAPKAN 2026-11-09 ~01:54 WIB — Eva menyetujui ("Perbaiki gate Solana dulu"), lib/security.js sudah ditimpa dengan file ini, zip v19. Jangan upload draft ini lagi; yang di-upload adalah lib/security.js.
Perbaikan gate Solana Franky Bot (RugCheck), disiapkan 2026-11-08 ~07:30 WIB.
Cara pakai bila Eva setuju: timpa lib/security.js dengan file
SOLANA-FIX-security.js ini, lalu upload file itu saja ke folder lib di
GitHub (Vercel deploy ulang otomatis). Tidak ada file lain yang berubah.
Isi perbaikan: checkToken('101', ...) kini memakai RugCheck, bukan GoPlus
(GoPlus tidak mendukung Solana, code 2022 — semua kandidat Solana selama
ini di-skip diam-diam). Aturan gate cerminan gate EVM: rugged -> tolak,
mintAuthority ada -> tolak, freezeAuthority ada -> tolak, creator >20% ->
tolak. Bila RugCheck tidak menjawab -> kandidat di-skip (fail closed).
Tes lokal 2026-11-08: BONK lolos, POPCAT lolos, JUP lolos, USDC Solana
ditolak (mintable), mint tidak valid ditolak. Catatan: gate ini TIDAK
membatasi konsentrasi 10 holder teratas (sama seperti gate EVM) — JUP
dengan top10 65,2% tetap lolos; Franky Check sendiri menandai konsentrasi
tinggi sebagai DUMP RISK. Bila Eva mau batas top10, itu ubahan terpisah.
