#!/usr/bin/env bash
# Upload folder images/ ke bucket Backblaze B2 lewat S3-compatible API.
#
# Butuh AWS CLI (https://aws.amazon.com/cli/) dan variabel lingkungan:
#   B2_KEY_ID     keyID dari Application Key B2
#   B2_APP_KEY    applicationKey (rahasia, jangan di-commit)
#   B2_BUCKET     nama bucket (bucket publik khusus gambar sejarah)
#   B2_ENDPOINT   endpoint S3 bucket, contoh https://s3.us-west-004.backblazeb2.com
#   B2_PREFIX     (opsional) folder di dalam bucket, default: sejarah
#
# Contoh:
#   B2_KEY_ID=xxx B2_APP_KEY=yyy B2_BUCKET=sejarah-img \
#   B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com bash scripts/upload-b2.sh
set -euo pipefail

: "${B2_KEY_ID:?Isi B2_KEY_ID}"
: "${B2_APP_KEY:?Isi B2_APP_KEY}"
: "${B2_BUCKET:?Isi B2_BUCKET}"
: "${B2_ENDPOINT:?Isi B2_ENDPOINT, contoh https://s3.us-west-004.backblazeb2.com}"
PREFIX="${B2_PREFIX:-sejarah}"

cd "$(dirname "$0")/.."

if [ ! -d images ]; then
  echo "Folder images/ belum ada. Jalankan dulu: node scripts/migrate-images.mjs --base <url>" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI belum terpasang. Lihat https://aws.amazon.com/cli/" >&2
  exit 1
fi

# Region diambil dari endpoint, contoh s3.us-west-004.backblazeb2.com -> us-west-004
REGION="$(printf '%s' "$B2_ENDPOINT" | sed -E 's#^https?://s3\.([^.]+)\.backblazeb2\.com.*#\1#')"

export AWS_ACCESS_KEY_ID="$B2_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$B2_APP_KEY"
export AWS_DEFAULT_REGION="$REGION"
# AWS CLI versi baru menambah checksum yang belum didukung B2
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

aws s3 sync images/ "s3://${B2_BUCKET}/${PREFIX}/" \
  --endpoint-url "$B2_ENDPOINT" \
  --cache-control "public, max-age=31536000, immutable" \
  --only-show-errors

echo "Selesai. Contoh cek di browser: <URL --base kamu>/$(ls images | head -n 1)"
