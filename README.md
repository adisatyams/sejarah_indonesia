# Tutur Tinular Sejarah Indonesia

Lini masa sejarah Indonesia berbasis [TimelineJS](https://timeline.knightlab.com/).
Situs ini statis (tanpa build), dihosting di **Cloudflare Pages**, dengan gambar disimpan di **Backblaze B2**.

## Struktur

```
index.html              halaman utama
_headers                header cache dan keamanan untuk Cloudflare Pages
timeline/js/data.js     isi lini masa (teks, tahun, URL gambar)
timeline/js/timeline.js pustaka TimelineJS
timeline/css/           gaya TimelineJS
scripts/                alat migrasi gambar ke Backblaze
```

## Deploy ke Cloudflare Pages

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, pilih repo ini.
2. Isi pengaturan build:
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: *(kosongkan)*
   - Build output directory: `/`
3. **Save and Deploy**. Setiap push ke `main` akan deploy otomatis, dan setiap Pull Request mendapat URL preview.

## Memindahkan gambar ke Backblaze B2

Saat ini banyak gambar di `data.js` masih menempel (hotlink) dari situs lain, jadi bisa hilang kapan saja.
Skrip di `scripts/` mengunduhnya, lalu mengarahkan `data.js` ke bucket kamu.

### 1. Siapkan bucket

- Buat bucket B2 **baru khusus gambar sejarah**, dengan akses **Public**. Jangan pakai bucket yang berisi file privat.
- Buat Application Key yang dibatasi ke bucket itu (izin baca dan tulis).
- Catat: nama bucket, endpoint S3 (contoh `https://s3.us-west-004.backblazeb2.com`), keyID dan applicationKey.
- URL publik bawaan B2 berbentuk `https://<host-friendly>.backblazeb2.com/file/<bucket>/sejarah`.
  Kalau kamu punya domain di Cloudflare, lebih baik pasang domain khusus gambar (misal `img.domainmu.com`) di depan bucket.
  URL domain itulah yang dipakai sebagai `--base` di bawah, sehingga kalau suatu hari pindah penyimpanan, cukup menjalankan skrip lagi.

### 2. Unduh gambar dan tulis ulang data.js

Butuh Node 18 atau lebih baru. Jalankan dari mana saja di dalam repo:

```bash
# lihat dulu daftar gambar, tanpa mengubah apa pun
node scripts/migrate-images.mjs --dry-run

# unduh ke folder images/ dan tulis ulang timeline/js/data.js
node scripts/migrate-images.mjs --base https://img.domainmu.com/sejarah
```

Catatan:

- Nama file memakai hash URL sehingga stabil dan aman dijalankan ulang.
- Gambar yang gagal diunduh (link mati, 404) **tidak diubah**: URL lamanya dibiarkan dan dicantumkan di laporan, supaya kamu bisa menggantinya manual.
- Thumbnail yang ternyata menunjuk halaman web (bukan gambar) otomatis diganti dengan gambar utama kejadian itu.
- Folder `images/` tidak masuk git. Gambar hidup di Backblaze.

### 3. Upload ke Backblaze

```bash
export B2_KEY_ID=...        # keyID
export B2_APP_KEY=...       # applicationKey
export B2_BUCKET=nama-bucket
export B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
# opsional, default: sejarah (harus sama dengan folder di akhir --base)
export B2_PREFIX=sejarah

bash scripts/upload-b2.sh
```

Skrip memakai AWS CLI (`aws`) lewat S3 API Backblaze dan memberi cache 1 tahun karena nama file tidak pernah berubah.
Jangan commit kunci B2. File `.env` sudah ada di `.gitignore`.

### 4. Commit dan deploy

```bash
git add timeline/js/data.js scripts/images-manifest.json
git commit -m "Pindahkan gambar ke Backblaze"
git push
```

Buka situsnya dan cek tab Network di browser: semua gambar harus datang dari domain bucket kamu.

## Menambah gambar baru

Taruh file gambar di `images/`, jalankan `bash scripts/upload-b2.sh`, lalu isi `url` di `data.js` dengan
`<URL --base>/<nama-file>`. Atau tempel URL gambar dari situs lain di `data.js` lalu jalankan ulang
`migrate-images.mjs`, dan skrip akan memindahkannya.

## Jalankan lokal

```bash
npx serve .
# atau
python3 -m http.server 8000
```
