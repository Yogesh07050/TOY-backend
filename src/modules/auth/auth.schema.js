'use strict';

const { z } = require('zod');
const { validateStrength } = require('../../utils/password');

const email = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(190);

const strongPassword = z
  .string({ required_error: 'Password is required' })
  .superRefine((value, ctx) => {
    for (const message of validateStrength(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    email,
    password: strongPassword,
    confirmPassword: z.string(),
    phone: z
      .string()
      .trim()
      .regex(/^[+\d][\d\s-]{5,20}$/, 'Enter a valid phone number')
      .optional()
      .or(z.literal('')),
    acceptedTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the terms and conditions' }),
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().optional().default(false),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

const forgotPasswordSchema = z.object({ email });

const resetPasswordSchema = z
  .object({
    token: z.string().min(10, 'Reset token is required'),
    password: strongPassword,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const verifyEmailSchema = z.object({ token: z.string().min(10, 'Verification token is required') });

const resendVerificationSchema = z.object({ email });

/** A session id is its refresh-token family id: 32 hex characters. */
const sessionIdParam = z.object({ id: z.string().regex(/^[a-f0-9-]{16,64}$/i, 'Invalid session id') });

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    password: strongPassword,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  changePasswordSchema,
  sessionIdParam,
};
