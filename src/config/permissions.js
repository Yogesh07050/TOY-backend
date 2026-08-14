'use strict';

/**
 * Canonical permission catalogue (§4). Seeded into the `permissions` table and
 * referenced by name everywhere in the codebase so typos surface at review time.
 */
const PERMISSIONS = {
  VIEW_OFFERS: { category: 'Offers', description: 'View offers' },
  CREATE_OFFER: { category: 'Offers', description: 'Create offers' },
  EDIT_OFFER: { category: 'Offers', description: 'Edit offers' },
  DELETE_OFFER: { category: 'Offers', description: 'Delete or deactivate offers' },
  MODERATE_REVIEWS: { category: 'Offers', description: 'Approve or reject reviews' },

  VIEW_SHOP: { category: 'Shops', description: 'View shop details' },
  CREATE_SHOP: { category: 'Shops', description: 'Create shops' },
  EDIT_SHOP: { category: 'Shops', description: 'Edit shops' },
  DELETE_SHOP: { category: 'Shops', description: 'Delete shops' },
  VIEW_SHOP_MEMBERS: { category: 'Shops', description: 'View the members of a shop' },
  MANAGE_SHOP_MEMBERS: { category: 'Shops', description: 'Add or remove shop members' },
  MANAGE_LOCATIONS: { category: 'Shops', description: 'Manage shop branches and locations' },

  VIEW_USERS: { category: 'Users', description: 'View users' },
  MANAGE_USERS: { category: 'Users', description: 'Create, edit and deactivate users' },
  MANAGE_ROLES: { category: 'Access control', description: 'Manage roles' },
  MANAGE_PERMISSIONS: { category: 'Access control', description: 'Manage permissions' },

  MANAGE_CATEGORIES: { category: 'Catalogue', description: 'Manage offer categories' },

  // Banner permissions are granted individually (§6). Holding the Admin role
  // is deliberately not enough - a Super Admin must grant each one.
  VIEW_BANNERS: { category: 'Banners', description: 'View featured banners' },
  CREATE_BANNER: { category: 'Banners', description: 'Create featured banners' },
  EDIT_BANNER: { category: 'Banners', description: 'Edit featured banners' },
  DELETE_BANNER: { category: 'Banners', description: 'Delete featured banners' },
  PUBLISH_BANNER: { category: 'Banners', description: 'Publish or deactivate banners' },

  REDEEM_CLAIM: { category: 'Offers', description: 'Redeem a customer offer claim' },

  VIEW_ANALYTICS: { category: 'Insights', description: 'View analytics dashboards' },
  VIEW_AUDIT_LOGS: { category: 'Insights', description: 'View audit logs' },
  // V3 §26: exporting takes data off the platform, so it is granted separately
  // from merely viewing a dashboard - on top of the plan entitlement.
  EXPORT_ANALYTICS: { category: 'Insights', description: 'Export analytics reports' },

  // V3 §38. Viewing the plan is safe for any shop member; changing it (and so
  // committing the merchant to a charge) is a deliberate, separate grant.
  VIEW_SUBSCRIPTION: { category: 'Subscription', description: 'View the shop subscription plan' },
  MANAGE_SUBSCRIPTION: {
    category: 'Subscription',
    description: 'Change the subscription plan and manage billing',
  },
  MANAGE_CAMPAIGNS: { category: 'Campaigns', description: 'Create and manage marketing campaigns' },

  // V4 §18: Services are a first-class listing type alongside offers, with
  // their own permission set mirroring the offer permissions above.
  CREATE_SERVICE: { category: 'Services', description: 'Create services' },
  VIEW_SERVICE: { category: 'Services', description: 'View services' },
  EDIT_SERVICE: { category: 'Services', description: 'Edit services' },
  DELETE_SERVICE: { category: 'Services', description: 'Delete or deactivate services' },
  PUBLISH_SERVICE: { category: 'Services', description: 'Publish or deactivate services' },
  SCHEDULE_SERVICE: { category: 'Services', description: 'Schedule services for future publishing' },
  MANAGE_SERVICE_OFFER: {
    category: 'Services',
    description: 'Create and manage offers attached to a service',
  },
  MANAGE_SERVICE_BOOKING: { category: 'Services', description: 'Manage customer service bookings' },
  VIEW_SERVICE_ANALYTICS: { category: 'Insights', description: 'View service analytics dashboards' },
  EXPORT_SERVICE_ANALYTICS: { category: 'Insights', description: 'Export service analytics reports' },
};

const PERMISSION_NAMES = Object.keys(PERMISSIONS);

/**
 * Roles created by the seeder.
 *
 * `scope` decides how a role's permissions are applied when it is assigned to a
 * user directly (via `user_roles`):
 *
 *   global - granted application-wide, across every shop
 *   shop   - granted only for the shops the user is a member of
 *
 * ADMIN is deliberately shop-scoped: §3.2 defines an Admin as "a user assigned
 * to a particular shop", so holding the role must never confer rights over
 * shops the user has nothing to do with.
 */
const SYSTEM_ROLES = {
  SUPER_ADMIN: {
    scope: 'global',
    description: 'Full access to every feature of the platform',
    permissions: PERMISSION_NAMES,
  },
  ADMIN: {
    scope: 'shop',
    description: 'Manages offers for the shops they are a member of',
    permissions: [
      'VIEW_OFFERS',
      'CREATE_OFFER',
      'EDIT_OFFER',
      'DELETE_OFFER',
      'VIEW_SHOP',
      'VIEW_SHOP_MEMBERS',
      'MANAGE_LOCATIONS',
      'VIEW_ANALYTICS',
      'EXPORT_ANALYTICS',
      'REDEEM_CLAIM',
      // The merchant owns their own plan, so an Admin of the shop can see it
      // and change it. What the plan then unlocks is enforced separately (§30).
      'VIEW_SUBSCRIPTION',
      'MANAGE_SUBSCRIPTION',
      'MANAGE_CAMPAIGNS',
      // Deliberately no *_BANNER permissions here: §6 requires a Super Admin to
      // grant those explicitly, per Admin.
      'CREATE_SERVICE',
      'VIEW_SERVICE',
      'EDIT_SERVICE',
      'DELETE_SERVICE',
      'PUBLISH_SERVICE',
      'SCHEDULE_SERVICE',
      'MANAGE_SERVICE_OFFER',
      'MANAGE_SERVICE_BOOKING',
      'VIEW_SERVICE_ANALYTICS',
      'EXPORT_SERVICE_ANALYTICS',
    ],
  },
  CUSTOMER: {
    scope: 'global',
    description: 'Discovers and saves offers',
    permissions: ['VIEW_OFFERS', 'VIEW_SHOP', 'VIEW_SERVICE'],
  },
};

/**
 * Permissions that mean "this person administers something". Used to decide who
 * may reach the admin area at all, regardless of which shop they hold them for.
 */
const MANAGEMENT_PERMISSIONS = [
  'VIEW_BANNERS',
  'CREATE_BANNER',
  'EDIT_BANNER',
  'DELETE_BANNER',
  'PUBLISH_BANNER',
  'CREATE_OFFER',
  'EDIT_OFFER',
  'DELETE_OFFER',
  'MANAGE_LOCATIONS',
  'VIEW_SHOP_MEMBERS',
  'MANAGE_SHOP_MEMBERS',
  'VIEW_ANALYTICS',
  'CREATE_SHOP',
  'EDIT_SHOP',
  'DELETE_SHOP',
  'MANAGE_CATEGORIES',
  'MANAGE_USERS',
  'VIEW_USERS',
  'MANAGE_ROLES',
  'MANAGE_PERMISSIONS',
  'MODERATE_REVIEWS',
  'VIEW_AUDIT_LOGS',
  'EXPORT_ANALYTICS',
  'VIEW_SUBSCRIPTION',
  'MANAGE_SUBSCRIPTION',
  'MANAGE_CAMPAIGNS',
  'CREATE_SERVICE',
  'EDIT_SERVICE',
  'DELETE_SERVICE',
  'VIEW_SERVICE_ANALYTICS',
];

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

module.exports = {
  PERMISSIONS,
  PERMISSION_NAMES,
  SYSTEM_ROLES,
  SUPER_ADMIN_ROLE,
  MANAGEMENT_PERMISSIONS,
};
