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
const DEFAULT_AMOUNT = parseInt(process.env.DEFAULT_AMOUNT || '25000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const AUTO_REPLY = process.env.AUTO_REPLY === '1';
const FONNTE_TOKEN = process.env.FONNTE_TOKEN || '';

function requireAdmin(req, res) {
  if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'Token admin salah' });
    return false;
  }
  return true;
}

function loadMembers() {
  return JSON.parse(fs.readFileSync(MEMBERS_PATH, 'utf-8'));
}

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(
      DATA_PATH,
      JSON.stringify({ payments: {}, log: [], lastReminder: {}, recapSent: {}, recapLog: [], expenses: [] }, null, 2)
    );
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  // jaga-jaga untuk data.json lama yang dibuat sebelum fitur ini ada
  if (!data.lastReminder) data.lastReminder = {};
  if (!data.recapSent) data.recapSent = {};
  if (!data.recapLog) data.recapLog = [];
  if (!data.expenses) data.expenses = [];
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function payKey(member, month) {
  return member + '||' + month;
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

  const data = loadData();
  data.payments[payKey(result.member, result.month)] = result.amount;
  data.log.unshift({
    member: result.member,
    month: result.month,
    amount: result.amount,
    text,
    at: new Date().toISOString(),
  });
  data.log = data.log.slice(0, 200); // simpan 200 log terakhir saja
  saveData(data);

  const rupiah = 'Rp' + result.amount.toLocaleString('id-ID');
  await sendWhatsAppReply(
    senderPhone,
    `Terima kasih ${result.member.split(' ')[0]}, iuran ${result.month} sebesar ${rupiah} sudah tercatat ✅`
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
