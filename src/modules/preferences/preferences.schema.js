'use strict';

const { z } = require('zod');
const { OFFER_TYPE_PREFERENCES, MIN_CATEGORY_PREFERENCES } = require('./preferences.constants');

const setPreferencesSchema = z.object({
  categoryIds: z
    .array(z.coerce.number().int().positive())
    .min(MIN_CATEGORY_PREFERENCES, `Select at least ${MIN_CATEGORY_PREFERENCES} categories`)
    .transform((ids) => [...new Set(ids)])
    .refine((ids) => ids.length >= MIN_CATEGORY_PREFERENCES, {
      message: `Select at least ${MIN_CATEGORY_PREFERENCES} categories`,
    }),
  shopIds: z.array(z.coerce.number().int().positive()).optional(),
  minimumDiscountPercent: z.coerce.number().int().min(0).max(100).nullable().optional(),
  offerTypes: z.array(z.enum(OFFER_TYPE_PREFERENCES)).optional(),
});

module.exports = { setPreferencesSchema };
