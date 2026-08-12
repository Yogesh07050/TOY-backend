'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');

const OFFER_TYPES = ['percentage', 'flat', 'buy_x_get_y', 'price_drop', 'up_to', 'other'];
const DISCOUNT_TYPES = ['percentage', 'flat', 'none'];
const STATUSES = ['draft', 'scheduled', 'active', 'expired', 'deactivated'];
const APPLICABILITY = ['shop_wide', 'selected_branches', 'online'];
const RECURRENCE = ['daily', 'weekly', 'monthly'];
const SORTS = ['newest', 'endingSoon', 'highestDiscount', 'mostViewed', 'mostPopular', 'nearest'];

const latitude = z.coerce.number().min(-90, 'Latitude must be between -90 and 90').max(90);
const longitude = z.coerce.number().min(-180, 'Longitude must be between -180 and 180').max(180);

const idList = z
  .union([z.string(), z.array(z.union([z.string(), z.number()])), z.number()])
  .transform((value) =>
    (Array.isArray(value) ? value : String(value).split(','))
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item) && item > 0),
  );

const optionalText = (max) => z.string().trim().max(max).optional().nullable();
const money = z.coerce.number().min(0).max(99999999).optional().nullable();

/** GET /api/offers - discovery query (§7, §9, §10, §32). */
const listOffersSchema = z
  .object({
    ...paginationSchema,
    search: z.string().trim().max(120).optional(),
    category: z.string().trim().max(140).optional(), // id or slug
    categoryId: z.coerce.number().int().positive().optional(),
    shop: z.string().trim().max(180).optional(), // id or slug
    shopId: z.coerce.number().int().positive().optional(),
    branchId: z.coerce.number().int().positive().optional(),
    city: z.string().trim().max(120).optional(),
    pincode: z.string().trim().max(20).optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    radius: z.coerce.number().min(0.1, 'Radius must be positive').max(500).optional(),
    minDiscount: z.coerce.number().min(0).max(100).optional(),
    maxDiscount: z.coerce.number().min(0).max(100).optional(),
    offerType: z.enum(OFFER_TYPES).optional(),
    status: z.enum([...STATUSES, 'all']).optional(),
    expiringInDays: z.coerce.number().int().min(1).max(365).optional(),
    // Hour granularity matters for Ending Soon, where "3 hours left" is the point.
    expiringInHours: z.coerce.number().int().min(1).max(8760).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    favorites: z.coerce.boolean().optional(),
    following: z.coerce.boolean().optional(),
    /** Management view: returns non-active offers, scoped to the caller's shops. */
    manage: z.coerce.boolean().optional(),
    sort: z.enum(SORTS).default('newest'),
  })
  .refine((data) => !(data.radius && (data.latitude === undefined || data.longitude === undefined)), {
    message: 'latitude and longitude are required when filtering by radius',
    path: ['radius'],
  })
  .refine((data) => !(data.sort === 'nearest' && data.latitude === undefined), {
    message: 'latitude and longitude are required to sort by distance',
    path: ['sort'],
  });

const offerBody = z
  .object({
    shopId: z.coerce.number().int().positive({ message: 'Shop is required' }),
    categoryId: z.coerce.number().int().positive().optional().nullable(),
    subcategoryId: z.coerce.number().int().positive().optional().nullable(),
    title: z.string().trim().min(3, 'Offer title is required').max(200),
    productName: optionalText(200),
    description: optionalText(5000),
    offerText: optionalText(200),
    offerType: z.enum(OFFER_TYPES).default('percentage'),
    discountType: z.enum(DISCOUNT_TYPES).default('percentage'),
    discountValue: z.coerce.number().min(0).max(100000).optional().nullable(),
    originalPrice: money,
    discountedPrice: money,
    buyQuantity: z.coerce.number().int().min(1).max(999).optional().nullable(),
    getQuantity: z.coerce.number().int().min(1).max(999).optional().nullable(),
    minPurchase: money,
    termsConditions: optionalText(5000),
    eligibility: optionalText(2000),
    usageRestrictions: optionalText(2000),
    applicableProducts: optionalText(500),
    isRecurring: z.coerce.boolean().default(false),
    recurrenceType: z.enum(RECURRENCE).optional().nullable(),
    startDate: z.coerce.date({ required_error: 'Start date is required' }),
    endDate: z.coerce.date({ required_error: 'End date is required' }),
    status: z.enum(['draft', 'scheduled', 'active']).default('draft'),
    applicabilityType: z.enum(APPLICABILITY).default('shop_wide'),
    branchIds: idList.optional().default([]),
    images: z
      .array(
        z.object({
          url: z.string().url().max(500),
          thumbnailUrl: z.string().url().max(500).optional().nullable(),
        }),
      )
      .max(8)
      .optional()
      .default([]),
  })
  .superRefine((data, ctx) => {
    if (data.endDate <= data.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date must be after the start date' });
    }
    if (data.discountType === 'percentage' && data.discountValue != null && data.discountValue > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'A percentage discount cannot exceed 100' });
    }
    if (data.discountType !== 'none' && (data.discountValue == null || data.discountValue <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'Enter the discount value' });
    }
    if (data.offerType === 'buy_x_get_y' && (!data.buyQuantity || !data.getQuantity)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buyQuantity'], message: 'Buy and get quantities are required for this offer type' });
    }
    if (data.originalPrice != null && data.discountedPrice != null && data.discountedPrice > data.originalPrice) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountedPrice'], message: 'Discounted price cannot exceed the original price' });
    }
    if (data.applicabilityType === 'selected_branches' && data.branchIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['branchIds'], message: 'Select at least one branch' });
    }
    if (data.isRecurring && !data.recurrenceType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrenceType'], message: 'Choose how often the offer recurs' });
    }
  });

const createOfferSchema = offerBody;
// `partial()` is unavailable on an effect-wrapped schema, so updates re-use the
// full body: the client always submits the complete offer form.
const updateOfferSchema = offerBody;

const updateStatusSchema = z.object({
  status: z.enum(STATUSES, { errorMap: () => ({ message: 'Unknown offer status' }) }),
});

const trackEventSchema = z.object({
  event: z.enum(['view', 'click', 'share']).default('view'),
  branchId: z.coerce.number().int().positive().optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

module.exports = {
  OFFER_TYPES,
  DISCOUNT_TYPES,
  STATUSES,
  APPLICABILITY,
  SORTS,
  listOffersSchema,
  createOfferSchema,
  updateOfferSchema,
  updateStatusSchema,
  trackEventSchema,
  idParam,
};
