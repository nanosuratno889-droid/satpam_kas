// server.js
// Server ini melakukan 3 hal:
// 1. Menerima notifikasi pesan masuk dari gateway WhatsApp (endpoint /webhook/fonnte)
// 2. Mencatat pembayaran ke file data.json (bisa diganti database asli nanti)
// 3. Menyediakan dashboard web (folder /public) yang membaca data itu secara live

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { parseMessage } = require('./parser');
const { sendReminders, DEFAULT_TEMPLATE } = require('./reminder');
const { buildRecapPdf, buildExpensePdf } = require('./recap');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const MEMBERS_PATH = path.join(__dirname, 'members.json');
const DATA_PATH = path.join(__dirname, 'data.json');
const RECAP_DIR = path.join(__dirname, 'public', 'recap');
// Folder bukti transfer SENGAJA di luar "public" (tidak bisa diakses lewat
// URL langsung oleh siapapun) karena foto bukti transfer bisa memuat info
// sensitif (nomor rekening, nama pengirim, dll). Hanya bisa dibuka lewat
// endpoint yang dikunci token admin.
const UPLOAD_ROOT = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
const BUKTI_DIR = path.join(UPLOAD_ROOT, 'bukti');
const DEFAULT_AMOUNT = parseInt(process.env.DEFAULT_AMOUNT || '25000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const AUTO_REPLY = process.env.AUTO_REPLY === '1';
const FONNTE_TOKEN = process.env.FONNTE_TOKEN || '';
const WAJIB_BUKTI_TRANSFER = process.env.WAJIB_BUKTI_TRANSFER !== '0'; // default: wajib

function requireAdmin(req, res) {
  if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'Token admin salah' });
    return false;
  }
  return true;
}

// Sama seperti requireAdmin, tapi juga menerima token lewat query string
// (?token=...) — dipakai untuk tautan gambar <a href> yang tidak bisa
// mengirim header custom.
function isAdminRequest(req) {
  if (!ADMIN_TOKEN) return true;
  return req.headers['x-admin-token'] === ADMIN_TOKEN || req.query.token === ADMIN_TOKEN;
}

function loadMembers() {
  return JSON.parse(fs.readFileSync(MEMBERS_PATH, 'utf-8'));
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(
      DATA_PATH,
      JSON.stringify({ payments: {}, log: [], lastReminder: {}, recapSent: {}, recapLog: [], expenses: [], bukti: {} }, null, 2)
    );
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  // jaga-jaga untuk data.json lama yang dibuat sebelum fitur ini ada
  if (!data.lastReminder) data.lastReminder = {};
  if (!data.recapSent) data.recapSent = {};
  if (!data.recapLog) data.recapLog = [];
  if (!data.expenses) data.expenses = [];
  if (!data.bukti) data.bukti = {};
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function payKey(member, month) {
  return member + '||' + month;
}

// Fonnte (dan gateway sejenis) mengirim tautan media di salah satu field ini
// saat anggota mengirim foto/gambar. Nama field bisa berbeda tergantung versi
// API mereka — kalau ternyata bukti tidak terdeteksi walau anggota sudah
// kirim foto, cek log Railway (baris "Pesan masuk (lengkap):") untuk melihat
// field apa yang benar-benar dipakai, lalu tambahkan ke daftar di bawah ini.
function extractMediaUrl(body) {
  const candidates = ['url', 'image', 'media', 'file', 'attachment', 'imageUrl', 'file_url'];
  for (const key of candidates) {
    const val = body[key];
    if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
  }
  return null;
}

function guessExtension(contentType, url) {
  if (contentType) {
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  }
  const match = (url || '').match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
  if (match) return match[1].toLowerCase();
  return 'jpg';
}

function sanitizeForFilename(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function downloadBuktiTransfer(url, member, month) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  const contentType = response.headers['content-type'] || '';
  const ext = guessExtension(contentType, url);
  const filename = `${sanitizeForFilename(member)}_${sanitizeForFilename(month)}_${Date.now()}.${ext}`;
  if (!fs.existsSync(BUKTI_DIR)) fs.mkdirSync(BUKTI_DIR, { recursive: true });
  fs.writeFileSync(path.join(BUKTI_DIR, filename), response.data);
  return filename;
}

async function sendWhatsAppReply(toPhone, message) {
  if (!AUTO_REPLY || !FONNTE_TOKEN) return;
  try {
    await axios.post(
      'https://api.fonnte.com/send',
      { target: toPhone, message },
      { headers: { Authorization: FONNTE_TOKEN } }
    );
  } catch (err) {
    console.error('Gagal mengirim balasan WhatsApp:', err.message);
  }
}

async function sendDocumentTo(phone, fileUrl, filename, caption) {
  // Fonnte mengirim dokumen dengan field "url" berisi tautan file yang bisa
  // diakses publik. Kalau kamu ganti ke gateway lain, cek dokumentasi
  // mereka — nama field pengiriman dokumen bisa berbeda.
  return axios.post(
    'https://api.fonnte.com/send',
    { target: phone, url: fileUrl, filename, message: caption },
    { headers: { Authorization: FONNTE_TOKEN } }
  );
}

function isMonthComplete(month, members, payments) {
  return members.every(m => !!payments[payKey(m.name, month)]);
}

// Membuat PDF rekap lengkap lalu mengirimkannya ke semua anggota yang punya nomor.
// req dipakai untuk menebak alamat publik server ini (protokol + host).
async function generateAndSendRecap({ month, months, members, data, req }) {
  const pdfBuffer = await buildRecapPdf({
    months,
    members: members.map(m => m.name),
    payments: data.payments,
    title: `Rekap Kas Wajib — ${month} Lunas Semua`,
  });

  if (!fs.existsSync(RECAP_DIR)) fs.mkdirSync(RECAP_DIR, { recursive: true });
  const filename = `rekap-${month.toLowerCase()}-${Date.now()}.pdf`;
  fs.writeFileSync(path.join(RECAP_DIR, filename), pdfBuffer);

  const base = process.env.BASE_URL || (req ? `${req.protocol}://${req.get('host')}` : '');
  if (!base) throw new Error('Tidak bisa menentukan alamat server; isi BASE_URL di .env');
  const fileUrl = `${base}/recap/${filename}`;

  const sendResults = { sent: [], skipped_no_phone: [], failed: [] };
  if (FONNTE_TOKEN) {
    for (const member of members) {
      if (!member.phone || member.phone.includes('GANTI_DENGAN_NOMOR_ASLI')) {
        sendResults.skipped_no_phone.push(member.name);
        continue;
      }
      try {
        await sendDocumentTo(
          member.phone,
          fileUrl,
          `Rekap-Kas-${month}.pdf`,
          `Rekap kas bulan ${month} — alhamdulillah semua anggota sudah lunas 🙏`
        );
        sendResults.sent.push(member.name);
      } catch (err) {
        sendResults.failed.push({ name: member.name, error: err.message });
      }
      await new Promise(r => setTimeout(r, 1200)); // jeda antar pesan
    }
  }

  data.recapSent[month] = new Date().toISOString();
  data.recapLog.unshift({ month, at: new Date().toISOString(), fileUrl, ...sendResults });
  data.recapLog = data.recapLog.slice(0, 50);
  saveData(data);

  return { sent: true, fileUrl, ...sendResults };
}

// Dipanggil tiap ada pembayaran baru tercatat: cek apakah bulan itu jadi
// lunas semua, dan kalau iya, kirim rekap otomatis (hanya sekali per bulan).
async function maybeSendRecap(month, req) {
  const { months, members } = loadMembers();
  const data = loadData();
  if (!isMonthComplete(month, members, data.payments)) return { sent: false, reason: 'belum_lunas_semua' };
  if (data.recapSent[month]) return { sent: false, reason: 'sudah_pernah_dikirim' };
  return generateAndSendRecap({ month, months, members, data, req });
}

// ---- Endpoint utama: menerima pesan dari Fonnte ----
// Sesuaikan nama field di sini jika format webhook gateway kamu berbeda.
// Payload Fonnte umumnya berbentuk: { device, sender, message, name }
app.post('/webhook/fonnte', async (req, res) => {
  const body = req.body || {};
  const senderPhone = body.sender || body.from || '';
  const text = body.message || body.text || '';

  console.log('Pesan masuk:', { senderPhone, text });
  console.log('Pesan masuk (lengkap, untuk debug field bukti foto):', JSON.stringify(body));

  const { months, members } = loadMembers();
  const result = parseMessage({
    text,
    senderPhone,
    members,
    months,
    defaultAmount: DEFAULT_AMOUNT,
  });

  if (!result.ok) {
    console.log('Pesan tidak dicatat:', result.reason);
    return res.json({ recorded: false, reason: result.reason });
  }

  // Wajib lampirkan foto bukti transfer bersamaan dengan pesan pembayaran.
  // Anggota mengirim FOTO dengan caption "bayar juni 25000", bukan teks biasa.
  let buktiFilename = null;
  if (WAJIB_BUKTI_TRANSFER) {
    const mediaUrl = extractMediaUrl(body);
    if (!mediaUrl) {
      console.log('Pesan pembayaran tanpa foto bukti, diminta kirim ulang.');
      await sendWhatsAppReply(
        senderPhone,
        `Halo ${result.member.split(' ')[0]}, mohon lampirkan *foto/screenshot bukti transfer* bersamaan dengan pesan ini (kirim sebagai foto dengan caption "bayar ${result.month} ${result.amount}"), lalu kirim ulang ya 🙏`
      );
      return res.json({ recorded: false, reason: 'butuh_bukti_transfer' });
    }
    try {
      buktiFilename = await downloadBuktiTransfer(mediaUrl, result.member, result.month);
    } catch (err) {
      console.error('Gagal mengunduh bukti transfer:', err.message);
      await sendWhatsAppReply(
        senderPhone,
        `Maaf ${result.member.split(' ')[0]}, server gagal mengunduh foto bukti transfernya. Coba kirim ulang fotonya ya 🙏`
      );
      return res.json({ recorded: false, reason: 'gagal_unduh_bukti' });
    }
  }

  const data = loadData();
  const key = payKey(result.member, result.month);
  const sudahTercatatSama = data.payments[key] === result.amount;

  data.payments[key] = result.amount;
  if (buktiFilename) {
    data.bukti[key] = { filename: buktiFilename, at: new Date().toISOString() };
  }
  data.log.unshift({
    member: result.member,
    month: result.month,
    amount: result.amount,
    text,
    at: new Date().toISOString(),
  });
  data.log = data.log.slice(0, 200); // simpan 200 log terakhir saja
  saveData(data);

  if (sudahTercatatSama) {
    // Pembayaran ini persis sama dengan yang sudah tercatat sebelumnya —
    // kemungkinan gateway mengirim ulang webhook yang sama (retry, status
    // callback, dll). Jangan balas lagi supaya anggota tidak dibanjiri
    // pesan konfirmasi berulang.
    console.log('Pembayaran sudah pernah tercatat identik, balasan dilewati:', key);
    return res.json({ recorded: true, duplicate: true, ...result });
  }

  const rupiah = 'Rp' + result.amount.toLocaleString('id-ID');
  await sendWhatsAppReply(
    senderPhone,
    `Terima kasih ${result.member.split(' ')[0]}, iuran ${result.month} sebesar ${rupiah} sudah tercatat beserta bukti transfernya ✅`
  );

  maybeSendRecap(result.month, req).catch(err => console.error('Gagal kirim rekap otomatis:', err.message));

  res.json({ recorded: true, ...result });
});

// ---- API untuk dashboard ----
app.get('/api/data', (req, res) => {
  const { months, members } = loadMembers();
  const data = loadData();
  const totalMasuk = Object.values(data.payments).reduce((s, v) => s + Number(v || 0), 0);
  const totalKeluar = data.expenses.reduce((s, e) => s + Number(e.nominal || 0), 0);
  res.json({
    months,
    members: members.map(m => m.name),
    payments: data.payments,
    log: data.log.slice(0, 30),
    defaultTemplate: DEFAULT_TEMPLATE,
    reminderConfigured: !!FONNTE_TOKEN,
    recapSentMonths: Object.keys(data.recapSent),
    saldo: totalMasuk - totalKeluar,
  });
});

// Edit manual dari dashboard (perlu ADMIN_TOKEN di header x-admin-token)
app.post('/api/manual', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { member, month, amount } = req.body;
  if (!member || !month) return res.status(400).json({ error: 'member dan month wajib diisi' });

  const data = loadData();
  const isPaying = !(amount === null || amount === '' || amount === undefined);
  if (!isPaying) {
    delete data.payments[payKey(member, month)];
  } else {
    data.payments[payKey(member, month)] = parseInt(amount, 10);
  }
  saveData(data);

  if (isPaying) {
    maybeSendRecap(month, req).catch(err => console.error('Gagal kirim rekap otomatis:', err.message));
  }
  res.json({ ok: true });
});

// Unduh rekap lengkap (semua bulan) sebagai PDF kapan saja, tidak perlu tunggu lunas semua.
app.get('/api/rekap/download', async (req, res) => {
  const { months, members } = loadMembers();
  const data = loadData();
  try {
    const pdfBuffer = await buildRecapPdf({
      months,
      members: members.map(m => m.name),
      payments: data.payments,
      title: 'Rekap Kas Wajib',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="rekap-kas.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kirim ulang / paksa kirim rekap PDF ke semua anggota untuk bulan tertentu,
// dipakai kalau admin mau mengirim manual tanpa menunggu status lunas semua.
app.post('/api/rekap/kirim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { month } = req.body;
  if (!month) return res.status(400).json({ error: 'month wajib diisi' });
  if (!FONNTE_TOKEN) return res.status(400).json({ error: 'FONNTE_TOKEN belum diisi di .env' });

  const { months, members } = loadMembers();
  if (!months.includes(month)) return res.status(400).json({ error: `Bulan "${month}" tidak dikenali` });
  const data = loadData();
  try {
    const result = await generateAndSendRecap({ month, months, members, data, req });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Pengeluaran kas: dilihat & diunduh anggota, ditambah oleh admin ----
app.get('/api/pengeluaran', (req, res) => {
  const data = loadData();
  const totalMasuk = Object.values(data.payments).reduce((s, v) => s + Number(v || 0), 0);
  const totalKeluar = data.expenses.reduce((s, e) => s + Number(e.nominal || 0), 0);
  res.json({
    expenses: data.expenses,
    totalMasuk,
    totalKeluar,
    saldo: totalMasuk - totalKeluar,
  });
});

app.post('/api/pengeluaran', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { tanggal, keterangan, nominal } = req.body;
  if (!tanggal || !keterangan || !nominal) {
    return res.status(400).json({ error: 'tanggal, keterangan, dan nominal wajib diisi' });
  }
  const data = loadData();
  data.expenses.unshift({
    id: Date.now().toString(36),
    tanggal,
    keterangan,
    nominal: parseInt(nominal, 10),
    at: new Date().toISOString(),
  });
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/pengeluaran/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const data = loadData();
  data.expenses = data.expenses.filter(e => e.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// Unduh daftar pengeluaran sebagai PDF — sengaja tidak dikunci token supaya
// anggota kas juga bisa mengunduhnya untuk transparansi.
app.get('/api/pengeluaran/pdf', async (req, res) => {
  const data = loadData();
  const totalMasuk = Object.values(data.payments).reduce((s, v) => s + Number(v || 0), 0);
  try {
    const pdfBuffer = await buildExpensePdf({
      expenses: data.expenses,
      totalMasuk,
      title: 'Rekap Pengeluaran Kas',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="pengeluaran-kas.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Bukti transfer: hanya bisa dilihat admin (foto bisa memuat info rekening) ----
app.get('/api/bukti', (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Token admin salah' });
  const data = loadData();
  const entries = Object.entries(data.bukti).map(([key, v]) => {
    const [member, month] = key.split('||');
    return { member, month, filename: v.filename, at: v.at };
  });
  entries.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ entries });
});

app.get('/api/bukti/file', (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).send('Token admin salah');
  const { member, month } = req.query;
  if (!member || !month) return res.status(400).send('member dan month wajib diisi');
  const data = loadData();
  const entry = data.bukti[payKey(member, month)];
  if (!entry) return res.status(404).send('Bukti tidak ditemukan');
  const filePath = path.join(BUKTI_DIR, entry.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File bukti sudah tidak ada di server');
  res.sendFile(filePath);
});

// ---- Penagihan: kirim pesan ke anggota yang belum bayar ----
// Dipanggil manual dari dashboard, atau otomatis lewat jadwal cron di bawah.
async function runReminderJob(month, options = {}) {
  const { months, members } = loadMembers();
  if (!months.includes(month)) {
    return { error: `Bulan "${month}" tidak ada di daftar bulan` };
  }
  const data = loadData();
  const results = await sendReminders({
    month,
    amount: DEFAULT_AMOUNT,
    members,
    payments: data.payments,
    lastReminder: data.lastReminder,
    fonnteToken: FONNTE_TOKEN,
    template: options.template || process.env.REMINDER_TEMPLATE || DEFAULT_TEMPLATE,
    cooldownHours: parseInt(process.env.REMINDER_COOLDOWN_HOURS || '20', 10),
    force: !!options.force,
  });
  saveData(data); // data.lastReminder diubah langsung oleh sendReminders, jadi disimpan lagi
  console.log('Hasil penagihan', month, results);
  return results;
}

app.post('/api/tagih', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { month, template, force } = req.body;
  if (!month) return res.status(400).json({ error: 'month wajib diisi' });
  if (!FONNTE_TOKEN) {
    return res.status(400).json({ error: 'FONNTE_TOKEN belum diisi di .env, tidak bisa mengirim pesan' });
  }
  const result = await runReminderJob(month, { template, force });
  res.json(result);
});

// ---- Jadwal otomatis (opsional) ----
// Aktifkan dengan REMINDER_ENABLED=1 di .env. Jadwal dan bulan mana yang
// ditagih diatur lewat REMINDER_CRON dan REMINDER_MONTH.
// Contoh REMINDER_CRON untuk "tiap tanggal 25 jam 09:00": 0 9 25 * *
if (process.env.REMINDER_ENABLED === '1') {
  const cronExpr = process.env.REMINDER_CRON || '0 9 25 * *';
  const targetMonth = process.env.REMINDER_MONTH; // wajib diisi manual, lihat README
  if (!targetMonth) {
    console.warn('REMINDER_ENABLED=1 tapi REMINDER_MONTH belum diisi di .env — jadwal otomatis tidak dijalankan.');
  } else if (cron.validate(cronExpr)) {
    cron.schedule(cronExpr, () => {
      console.log('Menjalankan penagihan otomatis untuk', targetMonth);
      runReminderJob(targetMonth).catch(err => console.error('Gagal kirim penagihan otomatis:', err.message));
    });
    console.log(`Penagihan otomatis aktif: jadwal "${cronExpr}", bulan target "${targetMonth}"`);
  } else {
    console.warn('REMINDER_CRON tidak valid, jadwal otomatis tidak dijalankan:', cronExpr);
  }
}

// Health check sederhana, berguna untuk memastikan server hidup setelah deploy
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server kas jalan di http://localhost:${PORT}`);
  console.log(`Arahkan webhook Fonnte ke: https://<domain-kamu>/webhook/fonnte`);
});
