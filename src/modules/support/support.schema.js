'use strict';

const { z } = require('zod');
const { paginationSchema } = require('../../utils/pagination');

/**
 * The categories the Support page offers.
 *
 * Defined here rather than as a database enum because the list is product copy
 * that will change more often than the schema should, and a ticket filed under
 * a category that is later retired must keep reading back as what it was.
 *
 * "Report an issue" is deliberately two entries rather than one. The platform
 * lists merchant-submitted content, so "this offer is misleading" and "the app
 * crashed" arrive from different people, need different information and go to
 * different queues - collapsing them means the moderation reports are buried in
 * the bug reports.
 */
const CATEGORIES = [
  'account',
  'offers',
  'services',
  'claim',
  'redemption',
  'notifications',
  'location',
  'merchant',
  'billing',
  'technical',
  'report_problem',
  'report_content',
  'other',
];

/** What a report can be filed against. Anything else is not a thing we host. */
const REPORTABLE = ['offer', 'service', 'shop', 'service_offer'];

const STATUSES = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'];

const createTicketSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required').max(120),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(190),
    phone: z
      .string()
      .trim()
      .regex(/^[+\d][\d\s-]{5,20}$/, 'Enter a valid phone number')
      .max(30)
      .optional()
      .nullable(),
    userType: z.enum(['customer', 'merchant', 'guest']).default('customer'),
    category: z.enum(CATEGORIES),
    subject: z.string().trim().min(4, 'Give the request a short subject').max(200),
    description: z.string().trim().min(20, 'Please describe the problem in a little more detail').max(5000),
    // A URL from `POST /uploads/support`, not a file: uploads are a separate
    // endpoint everywhere else in this API and tickets are no exception.
    attachmentUrl: z.string().trim().max(500).optional().nullable(),
    entityType: z.enum(REPORTABLE).optional().nullable(),
    entityId: z.coerce.number().int().positive().optional().nullable(),
  })
  // A report is only useful if it says what it is about, and an entity id
  // without a type cannot be looked up. Neither half stands alone.
  .refine((value) => Boolean(value.entityType) === Boolean(value.entityId), {
    message: 'A report must name both what is being reported and which one',
    path: ['entityId'],
  })
  .refine((value) => value.category !== 'report_content' || Boolean(value.entityType), {
    message: 'Choose the offer, service or shop you are reporting',
    path: ['entityId'],
  });

const listTicketsSchema = z.object({
  ...paginationSchema,
  status: z.enum([...STATUSES, 'all']).optional(),
  category: z.enum(CATEGORIES).optional(),
  /** Matches a reference, subject, name or email. */
  search: z.string().trim().max(120).optional(),
});

const myTicketsSchema = z.object({ ...paginationSchema });

const updateTicketSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    // `null` unassigns, which is a real action rather than a missing field.
    assignedTo: z.coerce.number().int().positive().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const addMessageSchema = z.object({
  body: z.string().trim().min(1, 'Write a message').max(5000),
  /** Support-only. A note for the next person on the queue, never sent out. */
  isInternal: z.coerce.boolean().optional().default(false),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

module.exports = {
  CATEGORIES,
  REPORTABLE,
  STATUSES,
  createTicketSchema,
  listTicketsSchema,
  myTicketsSchema,
  updateTicketSchema,
  addMessageSchema,
  idParam,
};
