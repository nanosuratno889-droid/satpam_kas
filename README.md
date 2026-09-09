# Buku Kas Wajib — Server WhatsApp Otomatis

Server ini menerima pesan WhatsApp anggota (lewat gateway pihak ketiga), mencatatnya
ke tabel kas secara otomatis, membalas konfirmasi ke pengirim, dan menampilkan
dashboard live yang bisa dibuka siapa saja lewat browser.

## Cara kerjanya (alur singkat)

```
Anggota kirim WA          Gateway WhatsApp           Server ini            Dashboard
"Windy bayar juli 25000" ─▶  (Fonnte, dll)   ──▶  /webhook/fonnte  ──▶  /public/index.html
                                                   mencatat ke data.json      (live, auto-refresh)
                                                   membalas konfirmasi ◀─────────┘
```

Tidak ada cara bagi halaman web untuk "menyadap" WhatsApp langsung — WhatsApp
mengharuskan lewat nomor bisnis + penyedia gateway resmi. Server inilah yang jadi
jembatannya.

## Yang perlu disiapkan

1. **Nomor WhatsApp khusus untuk kas** (boleh nomor baru, tidak harus admin pribadi).
2. **Akun gateway WhatsApp.** Contoh yang umum dipakai di Indonesia dan mudah untuk grup kecil:
   - [Fonnte](https://fonnte.com) — bayar sekali per device, tidak perlu approval bisnis, cocok untuk RT/kelompok kecil. Kode di sini sudah disiapkan untuk format Fonnte.
   - Alternatif: Wablas, atau WhatsApp Business API resmi via Meta (lebih rumit, cocok kalau sudah organisasi besar).
3. **Tempat hosting untuk server ini**, karena harus punya alamat internet (URL) yang bisa dihubungi gateway 24 jam. Pilihan yang gratis/murah dan mudah untuk pemula: [Railway](https://railway.app) atau [Render](https://render.com). Tidak bisa dijalankan hanya dari laptop pribadi karena harus selalu menyala dan punya alamat tetap.

## Langkah instalasi

### 1. Isi data anggota
Buka `members.json`, ganti setiap `phone` dengan nomor WhatsApp asli anggota
(format bebas: `0812...`, `62812...`, atau `+62812...`, akan dinormalisasi otomatis).
Nomor ini dipakai untuk mencocokkan siapa yang mengirim pesan.

### 2. Salin file environment
```
cp .env.example .env
```
Isi `ADMIN_TOKEN` bebas (dipakai untuk mengunci edit manual di dashboard).
`FONNTE_TOKEN` diisi setelah langkah 3.

### 3. Buat akun Fonnte dan hubungkan nomor
- Daftar di fonnte.com, tambahkan device, scan QR dengan nomor WhatsApp kas.
- Salin **Token** device tersebut ke `.env` sebagai `FONNTE_TOKEN`.
- Di pengaturan device, isi kolom **Webhook URL** dengan:
  `https://<domain-server-kamu>/webhook/fonnte`
  (domain ini baru ada setelah langkah 4 selesai deploy)

### 4. Jalankan server
Lokal (untuk dicoba dulu):
```
npm install
npm start
```
Buka `http://localhost:3000` untuk lihat dashboard.

Untuk deploy sungguhan ke Railway/Render:
- Push folder ini ke repository GitHub.
- Buat project baru di Railway/Render, hubungkan ke repo tersebut.
- Isi Environment Variables di dashboard hosting (sama seperti isi `.env`).
- Setelah deploy selesai, kamu akan dapat URL publik, mis. `https://kas-rt.up.railway.app`.
- Masukkan `https://kas-rt.up.railway.app/webhook/fonnte` ke kolom Webhook di Fonnte.

### 5. Coba kirim pesan
Kirim pesan dari nomor anggota ke nomor kas, contoh:
```
bayar kas juli 25000
```
Server akan mencocokkan nomor pengirim ke nama di `members.json`, mencatatnya,
dan membalas konfirmasi (jika `AUTO_REPLY=1`). Dashboard di `/` akan
menampilkannya dalam 5 detik tanpa perlu refresh manual.

## Format pesan yang dikenali

Server hanya mencatat pesan yang mengandung kata kunci pembayaran
(`bayar`, `lunas`, `transfer`, `setor`, `kirim`, `iuran`, `kas`) **dan**
menyebut nama bulan. Ini supaya obrolan biasa di grup tidak salah tercatat.

Contoh yang dikenali:
- `bayar juli 25000`
- `kas agustus lunas`
- `sudah transfer kas untuk bulan september`

Nominal bersifat opsional — kalau tidak disebut, memakai `DEFAULT_AMOUNT` di `.env`.

## Penagihan ke anggota yang belum bayar

Ada dua cara mengirim penagihan lewat WhatsApp ke anggota yang belum bayar
pada bulan tertentu. Anggota yang sudah bayar otomatis dilewati, dan orang
yang sama tidak akan ditagih dua kali dalam `REMINDER_COOLDOWN_HOURS` jam
terakhir (default 20 jam) supaya tidak terasa spam.

### Cara 1 — tombol manual di dashboard
Buka dashboard (`/`), scroll ke panel **"Kirim penagihan"**, pilih bulan,
isi token admin, lalu klik **"Kirim ke yang belum bayar"**. Hasilnya (siapa
terkirim, siapa dilewati, siapa gagal) langsung ditampilkan.

### Cara 2 — jadwal otomatis
Isi di `.env`:
```
REMINDER_ENABLED=1
REMINDER_MONTH=JULI
REMINDER_CRON=0 9 25 * *
```
`REMINDER_MONTH` harus diperbarui manual tiap ganti bulan penagihan (server
tidak menebak bulan berjalan sendiri, karena nama bulan di `members.json`
bisa berbeda dari kalender asli). `REMINDER_CRON` pakai format cron standar
5 kolom (menit jam tanggal bulan hari) — contoh di atas berarti tiap tanggal
25 jam 09:00 pagi. Setelah ubah `.env`, restart servernya.

### Mengubah isi pesan
Template default:
> "Halo {nama}, iuran kas bulan {bulan} sebesar {nominal} belum tercatat. Mohon segera dibayarkan ya, lalu balas chat ini dengan "sudah bayar {bulan}" agar otomatis tercatat. Terima kasih 🙏"

Bisa diganti lewat kotak template di dashboard (khusus pengiriman manual saat itu),
atau permanen lewat `REMINDER_TEMPLATE` di `.env` (dipakai jadwal otomatis dan
jadi bawaan tombol manual). Placeholder yang tersedia: `{nama}` (nama depan),
`{nama_lengkap}`, `{bulan}`, `{nominal}`.

## Rekap PDF otomatis saat lunas semua

Setiap kali ada pembayaran baru tercatat (lewat WhatsApp atau input manual di
dashboard), server mengecek: apakah bulan itu sekarang **lunas 100%** (semua
anggota di `members.json` sudah punya catatan bayar)? Kalau iya, server:

1. Membuat file PDF berbentuk tabel bergaris (nomor, nama, kolom tiap bulan,
   baris total) — mirip tampilan Excel di lembar kas aslinya.
2. Menyimpan file itu di `public/recap/` (otomatis bisa diakses lewat URL
   karena folder `public` sudah disajikan sebagai file statis).
3. Mengirim file itu ke **setiap anggota yang punya nomor valid** di
   `members.json`, lewat WhatsApp, dengan pesan pengantar otomatis.

Ini hanya terjadi **sekali per bulan** — begitu terkirim, statusnya dicatat
supaya tidak terkirim berulang tiap ada perubahan kecil di bulan yang sama.

### Kalau mau lihat atau kirim manual
- **Unduh kapan saja** (tidak perlu tunggu lunas semua): buka dashboard →
  panel "Rekap kas (PDF)" → tombol "Unduh PDF rekap lengkap". Ini mengunduh
  rekap terkini apa adanya, termasuk kolom yang masih kosong.
- **Kirim ulang / kirim paksa** ke semua anggota untuk bulan tertentu: pilih
  bulan, isi token admin, klik "Kirim ulang ke semua anggota". Berguna kalau
  pengiriman otomatis gagal atau ingin dikirim ulang.

### Catatan jujur soal pengiriman dokumen WhatsApp
Kode ini memakai field `url` pada API Fonnte (server memberi tautan publik
ke file PDF, bukan mengunggah filenya langsung). Ini format umum untuk
Fonnte saat dokumen ini ditulis, tapi gateway WhatsApp sering mengubah
detail API mereka — **cek dokumentasi Fonnte terbaru** kalau pengiriman
dokumen gagal, dan sesuaikan fungsi `sendDocumentTo` di `server.js` bila
nama field berbeda. Kalau kamu pakai gateway lain (bukan Fonnte), fungsi ini
juga perlu disesuaikan.

## Panel pengeluaran kas

Panel "Pengeluaran kas" di dashboard menampilkan daftar pengeluaran (tanggal,
keterangan, nominal) beserta ringkasan saldo (total pemasukan − total
pengeluaran = saldo kas saat ini). Panel ini **terbuka untuk dilihat siapa
saja** yang membuka dashboard — cocok untuk transparansi ke anggota — tapi
menambah atau menghapus data pengeluaran tetap butuh token admin.

- **Anggota**: cukup buka dashboard, lihat tabel pengeluaran dan saldo, atau
  klik "Unduh PDF daftar pengeluaran" — tombol ini sengaja tidak dikunci
  token supaya anggota bisa mengunduhnya sendiri kapan saja.
- **Admin**: isi tanggal, keterangan, nominal, dan token admin di form atas
  tabel, lalu klik "+ Tambah". Untuk menghapus entri yang salah, klik
  "hapus" di baris terkait (juga butuh token admin, diisi di kolom yang
  sama).

Data pengeluaran disimpan di `data.json` bersama data pemasukan, jadi ikut
ter-backup dalam file yang sama.

## Menambah bulan baru

Edit `months` di `members.json`, tambahkan nama bulan baru di larik tersebut.
Dashboard akan otomatis menampilkan kolom baru.

## Keamanan & catatan penting

- `data.json` menyimpan seluruh riwayat pembayaran dalam file teks biasa di
  server. Untuk kelompok kecil ini cukup, tapi untuk jumlah anggota besar
  atau kebutuhan jangka panjang, sebaiknya diganti ke database asli
  (mis. PostgreSQL) — beri tahu saya kalau butuh bantuan migrasinya.
- Endpoint edit manual (`/api/manual`) dikunci dengan `ADMIN_TOKEN` sederhana.
  Ini cukup untuk kelompok kecil yang saling percaya, bukan tingkat keamanan
  perbankan.
- Field nama di payload webhook (`sender`, `message`) mengikuti format Fonnte.
  Kalau memakai gateway lain, cek dokumentasi mereka dan sesuaikan bagian
  `req.body` di `server.js`.
# satpam_kas
