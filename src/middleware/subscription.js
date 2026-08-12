'use strict';

const ApiError = require('../utils/ApiError');
const entitlements = require('../services/entitlements');

/**
 * Route-level subscription gate (V3 §30). The rules themselves live in
 * `services/entitlements.js`; this only decides which shop a request is about.
 */

/**
 * Requires the shop's plan to include `feature`.
 *
 * The shop id is read from `req.shopId` (set by `requireShopScope`), then the
 * route params, the query string and finally the body - the same precedence
 * `requireShopScope` uses, so the two always agree on which shop is in play.
 *
 * Super Admins are exempt: they administer the platform rather than subscribe
 * to it, so a merchant's plan must never block them from inspecting it.
 */
const requireFeature = (feature, param = 'shopId') => async (req, _res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    if (req.user.isSuperAdmin) return next();

    const shopId = req.shopId ?? req.params?.[param] ?? req.query?.[param] ?? req.body?.[param];

    if (!shopId) {
      // No shop named in the request: let it through when any shop the caller
      // manages has the feature, and leave the handler to scope the data.
      const permitted = await Promise.all(
        req.user.shops.map((shop) => entitlements.hasFeature(shop.shopId, feature)),
      );
      if (permitted.some(Boolean)) return next();
      throw entitlements.featureRefusal(feature, null);
    }

    await entitlements.assertFeature(Number(shopId), feature);
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { requireFeature };
