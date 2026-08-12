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

  VIEW_ANALYTICS: { category: 'Insights', description: 'View analytics dashboards' },
  VIEW_AUDIT_LOGS: { category: 'Insights', description: 'View audit logs' },
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
    ],
  },
  CUSTOMER: {
    scope: 'global',
    description: 'Discovers and saves offers',
    permissions: ['VIEW_OFFERS', 'VIEW_SHOP'],
  },
};

/**
 * Permissions that mean "this person administers something". Used to decide who
 * may reach the admin area at all, regardless of which shop they hold them for.
 */
const MANAGEMENT_PERMISSIONS = [
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
];

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

module.exports = {
  PERMISSIONS,
  PERMISSION_NAMES,
  SYSTEM_ROLES,
  SUPER_ADMIN_ROLE,
  MANAGEMENT_PERMISSIONS,
};
