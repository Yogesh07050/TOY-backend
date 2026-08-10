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

/** Roles created by the seeder. Super Admin implicitly receives every permission. */
const SYSTEM_ROLES = {
  SUPER_ADMIN: {
    description: 'Full access to every feature of the platform',
    permissions: PERMISSION_NAMES,
  },
  ADMIN: {
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
    description: 'Discovers and saves offers',
    permissions: ['VIEW_OFFERS', 'VIEW_SHOP'],
  },
};

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

module.exports = { PERMISSIONS, PERMISSION_NAMES, SYSTEM_ROLES, SUPER_ADMIN_ROLE };
