'use strict';

const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const { uploadLimiter } = require('../../middleware/rateLimit');
const { single, many } = require('../../middleware/upload');
const storage = require('../../services/storage');
const accessControl = require('../../services/accessControl');
const { requirePermission } = require('../../middleware/authorize');
const { created } = require('../../utils/respond');

const router = express.Router();

const FOLDERS = {
  offers: { folder: 'offers', variant: 'offer' },
  shops: { folder: 'shops', variant: 'shopLogo' },
  categories: { folder: 'categories', variant: 'shopLogo' },
  // Banners are wide promotional art, so they keep more width than an offer photo.
  banners: { folder: 'banners', variant: 'banner' },
  avatars: { folder: 'avatars', variant: 'avatar' },
  services: { folder: 'services', variant: 'offer' },
};

const typeParam = z.object({ type: z.enum(Object.keys(FOLDERS)) });

router.use(authenticate, uploadLimiter);

/**
 * Uploads return URLs only. The caller then references those URLs when saving
 * the offer/shop, which keeps binaries out of MySQL entirely (§29).
 */
router.post(
  '/:type',
  validate({ params: typeParam }),
  (req, _res, next) => {
    // Anyone signed in may replace their own avatar; the other buckets require
    // one of the permissions that lets a user author the content they belong to.
    if (req.params.type === 'avatars') return next();
    const allowed = [
      'CREATE_OFFER',
      'EDIT_OFFER',
      'CREATE_SHOP',
      'EDIT_SHOP',
      'MANAGE_CATEGORIES',
      'CREATE_BANNER',
      'EDIT_BANNER',
      'CREATE_SERVICE',
      'EDIT_SERVICE',
    ];
    if (allowed.some((permission) => accessControl.hasAnyPermission(req.user, permission))) {
      return next();
    }
    next(ApiError.forbidden('You do not have permission to upload images'));
  },
  single('image'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Attach an image in the "image" field');
    const config = FOLDERS[req.params.type];
    const result = await storage.processImage(req.file, config);
    created(res, result);
  }),
);

/** Batch endpoint for the offer form, which supports several images (§29). */
router.post(
  '/offers/batch',
  requirePermission('CREATE_OFFER'),
  many('images', 8),
  asyncHandler(async (req, res) => {
    if (!req.files?.length) throw ApiError.badRequest('Attach at least one image in the "images" field');
    const results = [];
    for (const file of req.files) {
      results.push(await storage.processImage(file, FOLDERS.offers));
    }
    created(res, results);
  }),
);

module.exports = router;
