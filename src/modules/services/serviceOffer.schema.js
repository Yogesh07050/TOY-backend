'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');
const { queryBoolean } = require('../../utils/queryBoolean');

const OFFER_TYPES = ['percentage', 'flat', 'price_drop', 'other'];
const DISCOUNT_TYPES = ['percentage', 'flat', 'none'];
const STATUSES = ['draft', 'scheduled', 'active', 'expired', 'deactivated'];
const RECURRENCE = ['daily', 'weekly', 'monthly'];

const optionalText = (max) => z.string().trim().max(max).optional().nullable();
const money = z.coerce.number().min(0).max(99999999).optional().nullable();

const listServiceOffersSchema = z.object({
  ...paginationSchema,
  status: z.enum([...STATUSES, 'all']).optional(),
  /** Management view: returns non-active offers, scoped by the caller's permission check. */
  manage: queryBoolean(),
});

const serviceOfferBody = z
  .object({
    offerText: optionalText(200),
    offerType: z.enum(OFFER_TYPES).default('percentage'),
    discountType: z.enum(DISCOUNT_TYPES).default('percentage'),
    discountValue: z.coerce.number().min(0).max(100000).optional().nullable(),
    originalPrice: money,
    offerPrice: money,
    termsConditions: optionalText(5000),
    isRecurring: z.coerce.boolean().default(false),
    recurrenceType: z.enum(RECURRENCE).optional().nullable(),
    startDate: z.coerce.date({ required_error: 'Start date is required' }),
    endDate: z.coerce.date({ required_error: 'End date is required' }),
    status: z.enum(['draft', 'scheduled', 'active']).default('draft'),
    // Claim rules, identical to the ones on a product offer (§17, §22). The
    // defaults give an untouched service offer one code per customer, used once.
    claimLimitPerCustomer: z.coerce.number().int().min(1).max(100).default(1),
    totalClaimLimit: z.coerce.number().int().min(1).max(1000000).optional().nullable(),
    claimValidityHours: z.coerce.number().int().min(1).max(8760).optional().nullable(),
    maxRedemptionsPerClaim: z.coerce.number().int().min(1).max(100).default(1),
  })
  .superRefine((data, ctx) => {
    if (data.endDate <= data.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date must be after the start date' });
    }
    if (data.totalClaimLimit != null && data.claimLimitPerCustomer > data.totalClaimLimit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalClaimLimit'],
        message: 'The total claim limit cannot be lower than the per-customer limit',
      });
    }
    if (data.discountType === 'percentage' && data.discountValue != null && data.discountValue > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'A percentage discount cannot exceed 100' });
    }
    if (data.discountType !== 'none' && (data.discountValue == null || data.discountValue <= 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['discountValue'], message: 'Enter the discount value' });
    }
    if (data.originalPrice != null && data.offerPrice != null && data.offerPrice > data.originalPrice) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['offerPrice'], message: 'Offer price cannot exceed the original price' });
    }
    if (data.isRecurring && !data.recurrenceType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recurrenceType'], message: 'Choose how often the offer recurs' });
    }
  });

const updateStatusSchema = z.object({
  status: z.enum(STATUSES, { errorMap: () => ({ message: 'Unknown service offer status' }) }),
});

const serviceIdParam = z.object({ id: z.coerce.number().int().positive() });
const serviceOfferIdParam = z.object({
  id: z.coerce.number().int().positive(),
  offerId: z.coerce.number().int().positive(),
});

module.exports = {
  OFFER_TYPES,
  DISCOUNT_TYPES,
  STATUSES,
  listServiceOffersSchema,
  serviceOfferBody,
  updateStatusSchema,
  serviceIdParam,
  serviceOfferIdParam,
};
