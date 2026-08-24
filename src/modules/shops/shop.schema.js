'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');
const { queryBoolean } = require('../../utils/queryBoolean');

const latitude = z.coerce.number().min(-90).max(90).optional().nullable();
const longitude = z.coerce.number().min(-180).max(180).optional().nullable();
const optionalText = (max) => z.string().trim().max(max).optional().nullable();

const categoryIds = z
  .union([z.string(), z.array(z.union([z.string(), z.number()])), z.number()])
  .transform((value) =>
    (Array.isArray(value) ? value : String(value).split(','))
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item) && item > 0),
  )
  .optional()
  .default([]);

const listShopsSchema = z.object({
  ...paginationSchema,
  search: z.string().trim().max(160).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  city: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  mine: queryBoolean(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().min(0.1).max(500).optional(),
  sort: z.enum(['name', 'newest', 'popular', 'nearest']).default('name'),
});

const branchBody = z.object({
  branchName: z.string().trim().min(2, 'Branch name is required').max(160),
  address: optionalText(500),
  city: z.string().trim().min(1, 'City is required').max(120),
  state: optionalText(120),
  country: optionalText(120),
  pincode: optionalText(20),
  latitude,
  longitude,
  contactNumber: optionalText(30),
  isPrimary: z.coerce.boolean().optional().default(false),
  status: z.enum(['active', 'inactive']).optional().default('active'),
});

const shopBody = z.object({
  name: z.string().trim().min(2, 'Shop name is required').max(160),
  description: optionalText(5000),
  logoUrl: z.string().url().max(500).optional().nullable(),
  coverUrl: z.string().url().max(500).optional().nullable(),
  contactNumber: optionalText(30),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(190).optional().nullable().or(z.literal('')),
  websiteUrl: z.string().url().max(500).optional().nullable().or(z.literal('')),
  socialLinks: z.record(z.string().max(500)).optional().nullable(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
  categoryIds,
  // Convenience: creating a shop can create its first branch in one call (§16).
  primaryBranch: branchBody.optional().nullable(),
});

const updateShopSchema = shopBody.partial().extend({
  name: z.string().trim().min(2).max(160).optional(),
});

const memberBody = z.object({
  userId: z.coerce.number().int().positive().optional(),
  // When no account exists yet the Super Admin can invite by email (§18).
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(190).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  phone: optionalText(30),
  branchId: z.coerce.number().int().positive().optional().nullable(),
  roleId: z.coerce.number().int().positive().optional().nullable(),
  designation: optionalText(120),
  status: z.enum(['active', 'inactive']).optional().default('active'),
}).refine((data) => data.userId || data.email, {
  message: 'Provide an existing user or an email address to invite',
  path: ['email'],
});

const updateMemberSchema = z.object({
  branchId: z.coerce.number().int().positive().optional().nullable(),
  roleId: z.coerce.number().int().positive().optional().nullable(),
  designation: optionalText(120),
  status: z.enum(['active', 'inactive']).optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const branchParams = z.object({
  id: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().positive(),
});
const memberParams = z.object({
  id: z.coerce.number().int().positive(),
  memberId: z.coerce.number().int().positive(),
});

module.exports = {
  listShopsSchema,
  shopBody,
  updateShopSchema,
  branchBody,
  updateBranchSchema: branchBody.partial(),
  memberBody,
  updateMemberSchema,
  idParam,
  branchParams,
  memberParams,
};
