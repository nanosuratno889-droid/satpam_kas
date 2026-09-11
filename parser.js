// parser.js
// Semua logika "membaca" pesan WhatsApp ada di sini, terpisah dari server
// supaya mudah ditest dan diubah tanpa menyentuh kode webhook.

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cocokkan nomor pengirim ke anggota. Nomor WhatsApp dari gateway biasanya
// berformat 628xxxxxxxxxx (tanpa +, tanpa spasi). Kita normalisasi juga
// nomor di members.json supaya format 08xxx / +62 8xxx tetap cocok.
function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (p.startsWith('8')) p = '62' + p;
  return p;
}

function findMemberByPhone(members, senderPhone) {
  const target = normalizePhone(senderPhone);
  return members.find(m => normalizePhone(m.phone) === target) || null;
}

// Cadangan: kalau nomor pengirim belum terdaftar di members.json,
// coba cocokkan dari nama yang disebut di dalam teks pesan.
function findMemberByName(members, text) {
  const n = normalize(text);
  let best = null;
  let bestScore = 0;
  members.forEach(m => {
    const mn = normalize(m.name);
    let score = 0;
    if (n.includes(mn)) score = mn.length + 100;
    else {
      mn.split(' ').forEach(part => {
        if (part.length > 2 && n.includes(part)) score += part.length;
      });
    }
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  });
  return bestScore >= 3 ? best : null;
}

function findMonth(months, text) {
  const n = normalize(text);
  return months.find(m => n.includes(normalize(m))) || null;
}

function findAmount(text, fallback) {
  const cleaned = String(text || '').replace(/\./g, '');
  const match = cleaned.match(/(\d{4,7})/);
  return match ? parseInt(match[1], 10) : fallback;
}

// Kata kunci yang menandakan pesan ini memang laporan pembayaran,
// bukan obrolan biasa di grup. Supaya server tidak salah mencatat
// setiap pesan yang kebetulan menyebut nama bulan.
const PAYMENT_KEYWORDS = ['bayar', 'lunas', 'transfer', 'setor', 'kirim', 'iuran', 'kas'];

function looksLikePayment(text) {
  const n = normalize(text);
  return PAYMENT_KEYWORDS.some(k => n.includes(k));
}

/**
 * Fungsi utama: menerima teks pesan + info pengirim, mengembalikan hasil
 * pencocokan atau alasan kenapa gagal dicocokkan.
 */
function parseMessage({ text, senderPhone, members, months, defaultAmount }) {
  if (!looksLikePayment(text)) {
    return { ok: false, reason: 'bukan_pesan_pembayaran' };
  }

  const member =
    findMemberByPhone(members, senderPhone) || findMemberByName(members, text);
  if (!member) {
    return { ok: false, reason: 'anggota_tidak_dikenali' };
  }

  const month = findMonth(months, text);
  if (!month) {
    return { ok: false, reason: 'bulan_tidak_disebut', member };
  }

  const amount = findAmount(text, defaultAmount);

  return { ok: true, member: member.name, month, amount };
}

module.exports = { parseMessage, normalizePhone, normalize };
