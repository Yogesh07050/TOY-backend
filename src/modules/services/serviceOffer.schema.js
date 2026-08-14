'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');

const OFFER_TYPES = ['percentage', 'flat', 'price_drop', 'other'];
const DISCOUNT_TYPES = ['percentage', 'flat', 'none'];
const STATUSES = ['draft', 'scheduled', 'active', 'expired', 'deactivated'];
const RECURRENCE = ['daily', 'weekly', 'monthly'];

const optionalText = (max) => z.string().trim().max(max).optional().nullable();
const money = z.coerce.number().min(0).max(99999999).optional().nullable();

const listServiceOffersSchema = z.object({
  ...paginationSchema,
  status: z.enum([...STATUSES, 'all']).optional(),
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
