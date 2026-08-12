'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * Image pipeline (§29): validate type/size, strip metadata, resize, compress to
 * webp and emit a thumbnail. Binaries live on disk (or object storage); MySQL
 * only ever stores the resulting URLs.
 *
 * The public interface is driver-agnostic, so swapping `local` for S3 later is
 * a matter of implementing `put()` - nothing else in the codebase changes.
 */

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const SIZES = {
  offer: { width: 1200, height: 900 },
  banner: { width: 1920, height: 640 },
  shopLogo: { width: 512, height: 512 },
  avatar: { width: 256, height: 256 },
};
const THUMB = { width: 400, height: 300 };

const uniqueName = (extension) =>
  `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${extension}`;

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/** Writes a buffer into the configured store and returns its public URL. */
async function put(folder, filename, buffer) {
  if (env.storage.driver !== 'local') {
    // Object storage would be wired in here (S3 PutObject / GCS upload) and the
    // CDN URL returned. Kept explicit so the gap is obvious rather than silent.
    throw new ApiError(501, `Storage driver "${env.storage.driver}" is not implemented`);
  }
  const dir = path.join(env.storage.uploadDir, folder);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, filename), buffer);
  return `${env.publicApiUrl}/uploads/${folder}/${filename}`;
}

/**
 * Processes one uploaded file.
 * @param {{buffer: Buffer, mimetype: string, size: number}} file
 * @param {{folder: string, variant: keyof typeof SIZES, thumbnail?: boolean}} options
 * @returns {Promise<{url: string, thumbnailUrl: string|null, width: number, height: number, bytes: number}>}
 */
async function processImage(file, { folder, variant = 'offer', thumbnail = true }) {
  if (!file) throw ApiError.badRequest('No file received');
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw ApiError.badRequest('Unsupported image type. Use JPEG, PNG, WebP, GIF or AVIF.');
  }
  if (file.size > env.storage.maxUploadBytes) {
    throw ApiError.badRequest(`Image exceeds the ${env.storage.maxUploadBytes / 1048576} MB limit`);
  }

  let pipeline;
  try {
    // Re-encoding through sharp also neutralises polyglot files that merely
    // claim an image mime type.
    pipeline = sharp(file.buffer, { failOn: 'error' }).rotate();
    await pipeline.metadata();
  } catch {
    throw ApiError.badRequest('File is not a readable image');
  }

  const target = SIZES[variant] || SIZES.offer;
  const main = await sharp(file.buffer)
    .rotate()
    .resize({ ...target, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  const filename = uniqueName('webp');
  const url = await put(folder, filename, main.data);

  let thumbnailUrl = null;
  if (thumbnail) {
    const thumb = await sharp(file.buffer)
      .rotate()
      .resize({ ...THUMB, fit: 'cover', position: 'attention' })
      .webp({ quality: 72 })
      .toBuffer();
    thumbnailUrl = await put(`${folder}/thumbs`, filename, thumb);
  }

  return {
    url,
    thumbnailUrl,
    width: main.info.width,
    height: main.info.height,
    bytes: main.info.size,
  };
}

/** Best-effort delete of a previously stored URL. */
async function remove(url) {
  if (!url || env.storage.driver !== 'local') return;
  const marker = '/uploads/';
  const index = url.indexOf(marker);
  if (index === -1) return;
  const relative = url.slice(index + marker.length);
  // Reject traversal attempts before touching the filesystem.
  if (relative.includes('..')) return;
  await fs.rm(path.join(env.storage.uploadDir, relative), { force: true });
}

module.exports = { processImage, remove, ALLOWED_MIME, SIZES };
