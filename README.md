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

## Panel pengeluaran kas & pemasukan kas

Ada dua panel yang strukturnya sengaja dibuat sama persis: **"Pengeluaran
kas"** dan **"Pemasukan kas (lain-lain)"**. Keduanya **terbuka untuk
dilihat siapa saja** yang membuka dashboard — cocok untuk transparansi ke
anggota — tapi menambah atau menghapus data tetap butuh token admin.

**Pemasukan kas (lain-lain)** ini terpisah dari iuran wajib bulanan lewat
WhatsApp — dipakai untuk mencatat pemasukan lain seperti donasi, dana
tambahan, dsb. Total di panel "Ringkasan Saldo" otomatis menjumlahkan
keduanya: iuran wajib + pemasukan lain-lain, dikurangi pengeluaran.

Setiap entri (baik pengeluaran maupun pemasukan) punya kolom **Bulan**
(dropdown, bukan ketik manual) supaya rapi dan gampang dikelompokkan —
misalnya semua pengeluaran bulan Juni bisa langsung difilter lewat dropdown
**"Filter bulan"** di atas tabelnya, tanpa harus scroll cari manual.

- **Anggota**: buka dashboard, lihat tabel dan saldo, filter per bulan
  kalau perlu, atau klik "Unduh PDF" di masing-masing panel — tombol ini
  sengaja tidak dikunci token supaya anggota bisa mengunduhnya sendiri.
- **Admin**: isi tanggal, pilih bulan, isi keterangan, nominal, dan token
  admin di form atas tabel, lalu klik "+ Tambah". Untuk menghapus entri
  yang salah, klik "hapus" di baris terkait (juga butuh token admin).

Semua data ini disimpan di `data.json` yang sama dengan data iuran,
jadi ikut ter-backup dalam satu file.

## Wajib foto bukti transfer

Sekarang setiap kali anggota mau tercatat bayar lewat WhatsApp, **wajib
mengirim foto** (screenshot bukti transfer) dengan caption pesan
pembayarannya — bukan cukup ketik teks saja.

**Cara anggota membayar yang benar:** di WhatsApp, pilih ikon kamera/galeri,
lampirkan foto/screenshot bukti transfer, lalu di kolom **caption foto**
(bukan di kolom chat biasa) ketik `bayar juli 25000`, baru kirim.

- **Kalau anggota kirim teks saja tanpa foto** → server otomatis membalas
  minta kirim ulang dengan foto, dan **tidak mencatat** pembayaran apapun.
- **Kalau foto berhasil dikirim** → server mengunduh fotonya, menyimpannya,
  baru mencatat pembayaran dan membalas konfirmasi.

Untuk mematikan kewajiban ini (kembali ke mode bebas, teks saja boleh),
isi `WAJIB_BUKTI_TRANSFER=0` di `.env` lalu redeploy.

### Ke mana foto itu disimpan, dan siapa yang bisa lihat
Foto disimpan di folder `uploads/bukti/` di server — **bukan** di folder
`public`, supaya tidak bisa dibuka siapa saja lewat link biasa (foto bukti
transfer sering memuat info rekening). Untuk melihatnya, buka dashboard →
panel **"Bukti transfer"** → isi token admin → klik "Muat daftar bukti" →
klik "lihat foto" di baris anggota yang dicari.

### ⚠️ Penting: penyimpanan foto di Railway bersifat sementara
Secara default, setiap kali kamu redeploy (misalnya setelah commit baru di
GitHub) atau server di-restart, **seluruh isi folder `uploads/` ikut
terhapus** — ini karena Railway memakai filesystem sementara (ephemeral)
yang direset tiap deploy. Data pembayaran (`data.json`) juga ikut kena
masalah yang sama sebenarnya, jadi ini bukan cuma soal foto.

Supaya foto bukti transfer (dan seluruh data kas) **tidak hilang** tiap
kali ada perubahan kode, tambahkan **Volume** di Railway:
1. Di halaman service, buka tab **Settings** → **Volumes** → **"+ New Volume"**
2. Set mount path ke `/app/data` (atau path lain terserah)
3. Tambahkan environment variable di Railway: `UPLOAD_DIR=/app/data/uploads`
4. Redeploy sekali lagi

Setelah ada Volume, folder itu akan tetap ada walau redeploy berkali-kali.
Tanpa Volume, aplikasi tetap jalan normal sehari-hari, tapi ada risiko
riwayat pembayaran dan foto bukti hilang kalau suatu saat kamu update kode
lagi — jadi Volume ini sangat disarankan begitu kas mulai dipakai serius.

## Logo di halaman dashboard

Dashboard sudah punya lambang bawaan (lingkaran hijau bertuliskan "Rp") di
sebelah judul "Buku Kas Wajib" supaya tidak polos. Kalau organisasi kamu
punya logo sendiri (misalnya logo RT/perusahaan), tinggal:
1. Siapkan gambar logo, sebaiknya persegi (misal 200x200px), format PNG
2. Beri nama file persis **`logo.png`**
3. Upload ke folder **`public`** di repo GitHub (sejajar dengan `index.html`)
4. Commit — logo custom itu otomatis muncul menggantikan lambang bawaan,
   tidak perlu ubah kode apapun

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
- Field nama untuk **tautan foto** saat anggota mengirim gambar (dipakai
  fitur wajib bukti transfer) saya tebak dari nama-nama umum (`url`,
  `image`, `media`, `file`, dll) karena dokumentasi Fonnte soal ini bisa
  berubah. Kalau anggota sudah kirim foto tapi server tetap minta foto lagi
  (`butuh_bukti_transfer`), buka **Deploy Logs** di Railway, cari baris
  **"Pesan masuk (lengkap...)"** — itu menampilkan seluruh data mentah yang
  dikirim Fonnte. Lihat field mana yang berisi link fotonya, lalu tambahkan
  nama field itu ke daftar `candidates` di fungsi `extractMediaUrl` pada
  `server.js`.
