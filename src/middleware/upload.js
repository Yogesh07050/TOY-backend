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
      // §49: the merchant is told what would work, not what went wrong. The
      // detail carries the specifics so the form can list the accepted
      // formats next to the field rather than only in a toast.
      return cb(
        ApiError.badRequest(
          'This image can’t be uploaded. Please choose a supported image format within the allowed size.',
          {
            reason: 'UNSUPPORTED_TYPE',
            allowedFormats: ['JPEG', 'PNG', 'WebP', 'GIF', 'AVIF'],
            maxSizeMb: Math.round(env.storage.maxUploadBytes / (1024 * 1024)),
          },
        ),
      );
    }
    cb(null, true);
  },
});

const single = (field = 'image') => upload.single(field);
const many = (field = 'images', max = 8) => upload.array(field, max);

module.exports = { upload, single, many };
