'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');

const listReviewsSchema = z.object({
  ...paginationSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional(),
});

const createReviewSchema = z.object({
  rating: z.coerce.number().int().min(1, 'Rating must be 1-5').max(5, 'Rating must be 1-5'),
  comment: z.string().trim().max(2000).optional().nullable(),
});

const moderateReviewSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  comment: z.string().trim().max(2000).optional().nullable(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

module.exports = { listReviewsSchema, createReviewSchema, moderateReviewSchema, idParam };
