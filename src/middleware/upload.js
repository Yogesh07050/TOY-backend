'use strict';

const multer = require('multer');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { ALLOWED_MIME } = require('../services/storage');

/**
 * Files are buffered in memory so `services/storage` can re-encode them before
 * anything reaches disk - an unprocessed upload is never persisted.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.storage.maxUploadBytes, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(ApiError.badRequest('Unsupported image type. Use JPEG, PNG, WebP, GIF or AVIF.'));
    }
    cb(null, true);
  },
});

const single = (field = 'image') => upload.single(field);
const many = (field = 'images', max = 8) => upload.array(field, max);

module.exports = { upload, single, many };
