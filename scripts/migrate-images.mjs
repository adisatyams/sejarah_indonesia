#!/usr/bin/env node
/**
 * Pindahkan semua gambar di timeline/js/data.js ke Backblaze B2.
 *
 * Skrip ini:
 *   1. membaca data.js dan mengumpulkan semua URL gambar
 *      (background judul, media gambar, thumbnail),
 *   2. mengunduh tiap gambar ke folder images/ dengan nama stabil (hash URL),
 *   3. menulis ulang data.js supaya menunjuk ke URL publik bucket kamu.
 *
 * Upload ke Backblaze dilakukan terpisah: bash scripts/upload-b2.sh
 *
 * Pemakaian (butuh Node 18+, tanpa dependensi):
 *   node scripts/migrate-images.mjs --dry-run
 *   node scripts/migrate-images.mjs --base https://img.domainmu.com/sejarah
 *
 * Aman dijalankan ulang: gambar yang sudah diunduh dilewati, gambar yang gagal
 * tetap memakai URL lama sehingga situs tidak rusak.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA =
  "sejarah-indonesia-migrate/1.0 (+https://github.com/adisatyams/sejarah_indonesia)";

const { values: opts } = parseArgs({
  options: {
    base: { type: "string" },
    data: { type: "string", default: path.join(ROOT, "timeline/js/data.js") },
    out: { type: "string", default: path.join(ROOT, "images") },
    concurrency: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (opts.help) {
  console.log(`Pemakaian:
  node scripts/migrate-images.mjs --base <URL publik folder gambar> [opsi]

Opsi:
  --base <url>        URL publik tempat gambar akan disajikan, tanpa garis miring
                      di akhir. Contoh: https://img.domainmu.com/sejarah
  --dry-run           Hanya daftar URL gambar, tanpa unduh dan tanpa mengubah file
  --data <path>       Lokasi data.js (default: timeline/js/data.js)
  --out <folder>      Folder tujuan unduhan (default: images)
  --concurrency <n>   Jumlah unduhan paralel (default: 3)`);
  process.exit(0);
}

const dryRun = opts["dry-run"];
const base = (opts.base ?? "").replace(/\/+$/, "");
if (!dryRun && !base) {
  console.error("Isi --base dengan URL publik folder gambar, atau pakai --dry-run.");
  process.exit(1);
}

const MANIFEST_PATH = path.join(ROOT, "scripts/images-manifest.json");
const REPORT_PATH = path.join(ROOT, "scripts/.out/report.json");
const EXT_BY_TYPE = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isVideo = (u) => /youtu\.?be|vimeo/i.test(u ?? "");

// ---------- baca data.js ----------
const source = await readFile(opts.data, "utf8");
const data = JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1));

function collectRefs(d) {
  const refs = [];
  const add = (holder, key, kind, label) => {
    const url = holder?.[key];
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      refs.push({ holder, key, kind, label, url });
    }
  };
  add(d.title?.background, "url", "background", "judul (background)");
  if (d.title?.media && !isVideo(d.title.media.url)) {
    add(d.title.media, "url", "media", "judul (media)");
  }
  for (const ev of d.events ?? []) {
    const label = ev.text?.headline || ev.unique_id;
    const m = ev.media;
    if (!m) continue;
    if (m.mediatype?.type === "image") add(m, "url", "media", label);
    add(m, "thumbnail", "thumbnail", label);
  }
  return refs;
}

const refs = collectRefs(data);
const alreadyMigrated = (u) => base && u.startsWith(`${base}/`);
const unique = [...new Set(refs.map((r) => r.url))].filter((u) => !alreadyMigrated(u));

console.log(`Ditemukan ${refs.length} referensi gambar, ${unique.length} URL unik.`);

if (dryRun) {
  for (const u of unique) console.log(`  ${u}`);
  console.log("\nDry-run selesai, tidak ada file yang diubah.");
  process.exit(0);
}

// ---------- unduh ----------
const manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(await readFile(MANIFEST_PATH, "utf8"))
  : {};
await mkdir(opts.out, { recursive: true });

async function download(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "image/*,*/*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/")) {
        const err = new Error(`bukan gambar (${type || "tanpa content-type"})`);
        err.permanent = true;
        throw err;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("file kosong");
      return { buf, type };
    } catch (err) {
      lastErr = err;
      if (err.permanent) break;
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

function extensionFor(url, type) {
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  const m = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp|svg|avif)$/i);
  if (m) return `.${m[1].toLowerCase().replace("jpeg", "jpg")}`;
  throw new Error(`tipe gambar tidak dikenal (${type})`);
}

const results = new Map();
let done = 0;

async function processUrl(url) {
  const cached = manifest[url];
  if (cached && existsSync(path.join(opts.out, cached.file))) {
    results.set(url, { ok: true, ...cached, cached: true });
  } else {
    try {
      const { buf, type } = await download(url);
      const file = `${createHash("sha1").update(url).digest("hex").slice(0, 12)}${extensionFor(url, type)}`;
      await writeFile(path.join(opts.out, file), buf);
      const entry = { file, type, bytes: buf.length };
      manifest[url] = entry;
      results.set(url, { ok: true, ...entry });
    } catch (err) {
      results.set(url, { ok: false, error: err.message });
    }
  }
  const r = results.get(url);
  console.log(`[${++done}/${unique.length}] ${r.ok ? (r.cached ? "ada " : "ok  ") : "GAGAL"} ${url}${r.ok ? "" : `  -> ${r.error}`}`);
}

const queue = [...unique];
const workers = Array.from({ length: Math.max(1, Number(opts.concurrency) || 3) }, async () => {
  while (queue.length) await processUrl(queue.shift());
});
await Promise.all(workers);

// ---------- tulis ulang data.js ----------
let replaced = 0;
let thumbFallback = 0;
for (const r of refs) {
  const res = results.get(r.url);
  if (res?.ok) {
    r.holder[r.key] = `${base}/${res.file}`;
    replaced++;
  }
}
// Thumbnail yang rusak (mis. menunjuk halaman wiki, bukan gambar) -> pakai gambar utama
for (const ev of data.events ?? []) {
  const m = ev.media;
  if (!m?.thumbnail || alreadyMigrated(m.thumbnail)) continue;
  if (m.mediatype?.type === "image" && alreadyMigrated(m.url ?? "")) {
    console.log(`  thumbnail diganti dengan gambar utama: ${ev.text?.headline ?? ev.unique_id}`);
    m.thumbnail = m.url;
    thumbFallback++;
  }
}

await writeFile(opts.data, `var data = \n${JSON.stringify(data, null, 2)}\n`);
await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

const failed = [...results].filter(([, v]) => !v.ok).map(([url, v]) => ({ url, error: v.error }));
await mkdir(path.dirname(REPORT_PATH), { recursive: true });
await writeFile(REPORT_PATH, `${JSON.stringify({ replaced, thumbFallback, failed }, null, 2)}\n`);

console.log(`\nSelesai. ${replaced} referensi ditulis ulang di ${path.relative(ROOT, opts.data)}.`);
if (thumbFallback) console.log(`${thumbFallback} thumbnail rusak diganti dengan gambar utamanya.`);
if (failed.length) {
  console.log(`\n${failed.length} gambar gagal diunduh (URL lama dibiarkan, situs tetap jalan):`);
  for (const f of failed) console.log(`  - ${f.url}\n      ${f.error}`);
  console.log(`Daftar lengkap: ${path.relative(ROOT, REPORT_PATH)}`);
}
console.log("\nLangkah berikut: bash scripts/upload-b2.sh, lalu commit timeline/js/data.js.");
