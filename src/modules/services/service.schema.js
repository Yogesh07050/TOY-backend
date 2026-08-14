'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');
const { APPLICABILITY } = require('../offers/offer.schema');

const PRICING_TYPES = ['fixed', 'starting_from', 'price_on_enquiry'];
const BOOKING_TYPES = ['walk_in', 'appointment', 'both', 'enquiry_only'];
const STATUSES = ['draft', 'scheduled', 'active', 'paused', 'expired', 'deactivated'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SORTS = ['newest', 'mostViewed', 'mostPopular', 'nearest'];

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
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)')
  .optional()
  .nullable();

/** GET /api/services - discovery query, mirrors listOffersSchema (§9, §37). */
const listServicesSchema = z
  .object({
    ...paginationSchema,
    search: z.string().trim().max(120).optional(),
    category: z.string().trim().max(140).optional(),
    categoryId: z.coerce.number().int().positive().optional(),
    shop: z.string().trim().max(180).optional(),
    shopId: z.coerce.number().int().positive().optional(),
    branchId: z.coerce.number().int().positive().optional(),
    city: z.string().trim().max(120).optional(),
    pincode: z.string().trim().max(20).optional(),
    latitude: latitude.optional(),
    longitude: longitude.optional(),
    radius: z.coerce.number().min(0.1, 'Radius must be positive').max(500).optional(),
    pricingType: z.enum(PRICING_TYPES).optional(),
    bookingType: z.enum(BOOKING_TYPES).optional(),
    homeService: z.coerce.boolean().optional(),
    hasOffer: z.coerce.boolean().optional(),
    status: z.enum([...STATUSES, 'all']).optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    saved: z.coerce.boolean().optional(),
    /** Management view: returns non-active services, scoped to the caller's shops. */
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

const serviceBody = z
  .object({
    shopId: z.coerce.number().int().positive({ message: 'Shop is required' }),
    categoryId: z.coerce.number().int().positive().optional().nullable(),
    subcategoryId: z.coerce.number().int().positive().optional().nullable(),
    name: z.string().trim().min(3, 'Service name is required').max(200),
    description: optionalText(5000),
    pricingType: z.enum(PRICING_TYPES).default('fixed'),
    price: money,
    durationMinutes: z.coerce.number().int().min(1).max(1440).optional().nullable(),
    durationLabel: optionalText(60),
    availableDays: z.array(z.enum(DAYS)).max(7).optional().default([]),
    availableTimeStart: timeOfDay,
    availableTimeEnd: timeOfDay,
    homeService: z.coerce.boolean().default(false),
    walkInAvailable: z.coerce.boolean().default(false),
    appointmentRequired: z.coerce.boolean().default(false),
    bookingType: z.enum(BOOKING_TYPES).default('walk_in'),
    serviceArea: optionalText(255),
    termsConditions: optionalText(5000),
    applicabilityType: z.enum(APPLICABILITY).default('shop_wide'),
    status: z.enum(['draft', 'scheduled', 'active']).default('draft'),
    startDate: z.coerce.date().optional().nullable(),
    endDate: z.coerce.date().optional().nullable(),
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
    if (data.pricingType !== 'price_on_enquiry' && (data.price == null || data.price <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'Enter a price, or choose "Price on enquiry"' });
    }
    if (data.startDate && data.endDate && data.endDate <= data.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date must be after the start date' });
    }
    if (data.status === 'scheduled' && !data.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startDate'], message: 'A start date is required to schedule a service' });
    }
    if (data.applicabilityType === 'selected_branches' && data.branchIds.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['branchIds'], message: 'Select at least one branch' });
    }
    if (data.availableTimeStart && data.availableTimeEnd && data.availableTimeEnd <= data.availableTimeStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['availableTimeEnd'], message: 'Closing time must be after the opening time' });
    }
  });

const createServiceSchema = serviceBody;
const updateServiceSchema = serviceBody;

const updateStatusSchema = z.object({
  status: z.enum(STATUSES, { errorMap: () => ({ message: 'Unknown service status' }) }),
});

const trackEventSchema = z.object({
  event: z.enum(['view', 'click', 'share', 'enquire']).default('view'),
  branchId: z.coerce.number().int().positive().optional(),
  city: z.string().trim().max(120).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
});

const bookingBody = z.object({
  branchId: z.coerce.number().int().positive().optional().nullable(),
  serviceOfferId: z.coerce.number().int().positive().optional().nullable(),
  requestedAt: z.coerce.date().optional().nullable(),
  notes: optionalText(500),
});

const bookingStatusSchema = z.object({
  status: z.enum(['requested', 'confirmed', 'completed', 'cancelled']),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const bookingIdParam = z.object({
  id: z.coerce.number().int().positive(),
  bookingId: z.coerce.number().int().positive(),
});

module.exports = {
  PRICING_TYPES,
  BOOKING_TYPES,
  STATUSES,
  DAYS,
  SORTS,
  listServicesSchema,
  createServiceSchema,
  updateServiceSchema,
  updateStatusSchema,
  trackEventSchema,
  bookingBody,
  bookingStatusSchema,
  idParam,
  bookingIdParam,
};
