// reminder.js
// Mengurus pengiriman pesan penagihan ke anggota yang belum membayar
// untuk bulan tertentu. Dipisah dari server.js supaya gampang diubah
// templatenya tanpa menyentuh logika webhook.

const axios = require('axios');

const DEFAULT_TEMPLATE =
  'Halo {nama}, iuran kas bulan {bulan} sebesar {nominal} belum tercatat. ' +
  'Mohon segera dibayarkan ya, lalu balas chat ini dengan "sudah bayar {bulan}" agar otomatis tercatat. Terima kasih 🙏';

function fillTemplate(template, { nama, bulan, nominal }) {
  return template
    .replaceAll('{nama}', nama.split(' ')[0])
    .replaceAll('{nama_lengkap}', nama)
    .replaceAll('{bulan}', bulan)
    .replaceAll('{nominal}', 'Rp' + Number(nominal).toLocaleString('id-ID'));
}

function payKey(member, month) {
  return member + '||' + month;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendOne(fonnteToken, phone, message) {
  const res = await axios.post(
    'https://api.fonnte.com/send',
    { target: phone, message },
    { headers: { Authorization: fonnteToken } }
  );
  return res.data;
}

/**
 * Mengirim penagihan ke semua anggota yang belum bayar pada `month`.
 * - members: array {name, phone} dari members.json
 * - payments: object payKey -> amount dari data.json
 * - lastReminder: object payKey -> timestamp ISO, dipakai untuk cegah spam
 * - cooldownHours: jangan kirim ulang ke orang yang sama dalam N jam terakhir
 * Mengembalikan ringkasan: siapa terkirim, dilewati, atau gagal.
 */
async function sendReminders({
  month,
  amount,
  members,
  payments,
  lastReminder,
  fonnteToken,
  template,
  cooldownHours = 20,
  force = false,
  delayMs = 1200,
}) {
  const tpl = template && template.trim() ? template : DEFAULT_TEMPLATE;
  const results = { sent: [], skipped_paid: [], skipped_no_phone: [], skipped_cooldown: [], failed: [] };

  for (const member of members) {
    const key = payKey(member.name, month);

    if (payments[key]) {
      results.skipped_paid.push(member.name);
      continue;
    }

    if (!member.phone || member.phone.includes('GANTI_DENGAN_NOMOR_ASLI')) {
      results.skipped_no_phone.push(member.name);
      continue;
    }

    if (!force && lastReminder[key]) {
      const hoursSince = (Date.now() - new Date(lastReminder[key]).getTime()) / 36e5;
      if (hoursSince < cooldownHours) {
        results.skipped_cooldown.push(member.name);
        continue;
      }
    }

    const message = fillTemplate(tpl, { nama: member.name, bulan: month, nominal: amount });

    try {
      if (fonnteToken) {
        await sendOne(fonnteToken, member.phone, message);
      }
      lastReminder[key] = new Date().toISOString();
      results.sent.push(member.name);
    } catch (err) {
      results.failed.push({ name: member.name, error: err.message });
    }

    // jeda antar pesan supaya tidak dianggap spam oleh WhatsApp
    await sleep(delayMs);
  }

  return results;
}

module.exports = { sendReminders, fillTemplate, DEFAULT_TEMPLATE, payKey };
