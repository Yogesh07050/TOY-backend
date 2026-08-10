'use strict';

const { query } = require('../db/pool');
const { SUPER_ADMIN_ROLE } = require('../config/permissions');

/**
 * Resolves everything the authorization layer needs about a user:
 *
 *   - global roles (users -> user_roles -> roles)
 *   - permissions granted by those global roles
 *   - shop memberships, each with the permissions its shop-level role grants
 *
 * Permissions are resolved per request rather than embedded in the JWT so that
 * a revoked role takes effect immediately instead of at token expiry.
 */
async function loadAccessContext(userId) {
  const [roles, globalPermissions, memberships] = await Promise.all([
    query(
      `SELECT r.id, r.name, r.description
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.status = 'active'
        WHERE ur.user_id = ?`,
      [userId],
    ),
    query(
      `SELECT DISTINCT p.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.status = 'active'
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = ?`,
      [userId],
    ),
    query(
      `SELECT sm.id            AS member_id,
              sm.shop_id,
              sm.branch_id,
              sm.designation,
              sm.status,
              s.name           AS shop_name,
              s.slug           AS shop_slug,
              s.logo_url       AS shop_logo_url,
              r.id             AS role_id,
              r.name           AS role_name,
              GROUP_CONCAT(DISTINCT p.name) AS permissions
         FROM shop_members sm
         JOIN shops s ON s.id = sm.shop_id
         LEFT JOIN roles r ON r.id = sm.role_id AND r.status = 'active'
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE sm.user_id = ? AND sm.status = 'active' AND s.status = 'active'
        GROUP BY sm.id, sm.shop_id, sm.branch_id, sm.designation, sm.status,
                 s.name, s.slug, s.logo_url, r.id, r.name`,
      [userId],
    ),
  ]);

  const roleNames = roles.map((role) => role.name);
  const isSuperAdmin = roleNames.includes(SUPER_ADMIN_ROLE);

  const shops = memberships.map((row) => ({
    memberId: Number(row.member_id),
    shopId: Number(row.shop_id),
    branchId: row.branch_id === null ? null : Number(row.branch_id),
    shopName: row.shop_name,
    shopSlug: row.shop_slug,
    shopLogoUrl: row.shop_logo_url,
    designation: row.designation,
    roleId: row.role_id === null ? null : Number(row.role_id),
    roleName: row.role_name,
    permissions: row.permissions ? row.permissions.split(',') : [],
  }));

  const globalSet = new Set(globalPermissions.map((row) => row.name));

  return {
    roles: roles.map((role) => ({ id: Number(role.id), name: role.name, description: role.description })),
    roleNames,
    isSuperAdmin,
    globalPermissions: [...globalSet],
    shops,
    shopIds: shops.map((shop) => shop.shopId),
    /** Union of global + every shop-scoped permission; used for UI hints only. */
    effectivePermissions: [
      ...new Set([...globalSet, ...shops.flatMap((shop) => shop.permissions)]),
    ],
  };
}

/** True when the permission is granted application-wide (not just for one shop). */
function hasGlobalPermission(access, permission) {
  if (!access) return false;
  if (access.isSuperAdmin) return true;
  return access.globalPermissions.includes(permission);
}

/** True when the permission is granted for the given shop (globally or via membership). */
function hasShopPermission(access, shopId, permission) {
  if (!access) return false;
  if (hasGlobalPermission(access, permission)) return true;
  const membership = access.shops.find((shop) => shop.shopId === Number(shopId));
  return Boolean(membership && membership.permissions.includes(permission));
}

/** True when the permission is held anywhere - globally or for at least one shop. */
function hasAnyPermission(access, permission) {
  if (!access) return false;
  if (hasGlobalPermission(access, permission)) return true;
  return access.shops.some((shop) => shop.permissions.includes(permission));
}

/** Shop ids where the user holds `permission`; `null` means "every shop". */
function shopScopeFor(access, permission) {
  if (hasGlobalPermission(access, permission)) return null;
  return access.shops.filter((shop) => shop.permissions.includes(permission)).map((shop) => shop.shopId);
}

module.exports = {
  loadAccessContext,
  hasGlobalPermission,
  hasShopPermission,
  hasAnyPermission,
  shopScopeFor,
};
