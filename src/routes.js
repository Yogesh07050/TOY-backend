'use strict';

const express = require('express');

const router = express.Router();

router.use('/auth', require('./modules/auth/auth.routes'));
router.use('/users', require('./modules/users/user.routes'));
router.use('/roles', require('./modules/roles/role.routes'));
router.use('/permissions', require('./modules/permissions/permission.routes'));
router.use('/shops', require('./modules/shops/shop.routes'));
router.use('/categories', require('./modules/categories/category.routes'));
router.use('/offers', require('./modules/offers/offer.routes'));
router.use('/favorites', require('./modules/favorites/favorite.routes'));
router.use('/following', require('./modules/following/following.routes'));
router.use('/preferences', require('./modules/preferences/preferences.routes'));
router.use('/reviews', require('./modules/reviews/review.routes'));
router.use('/notifications', require('./modules/notifications/notification.routes'));
router.use('/analytics', require('./modules/analytics/analytics.routes'));
router.use('/audit-logs', require('./modules/audit/audit.routes'));
router.use('/uploads', require('./modules/uploads/upload.routes'));
// Address <-> coordinates for the map picker (V3 shop location, §5).
router.use('/geo', require('./modules/geo/geo.routes'));

// ---- V2 ----
router.use('/banners', require('./modules/banners/banner.routes'));
router.use('/discovery', require('./modules/discovery/discovery.routes'));
router.use('/search', require('./modules/search/search.routes'));
router.use('/claims', require('./modules/claims/claim.routes'));
// The merchant's side of the same workflow (Claim/Redemption §7-§11, §24-§26).
// Split from `/claims` on purpose: nothing a customer can reach is allowed to
// write a redemption, and separate routers make that impossible rather than
// merely unlikely.
router.use('/redemptions', require('./modules/claims/redemption.routes'));

// ---- V3 ----
router.use('/subscriptions', require('./modules/subscriptions/subscription.routes'));
router.use('/payments', require('./modules/payments/payment.routes'));
router.use('/feature-overrides', require('./modules/featureOverrides/featureOverride.routes'));
router.use('/campaigns', require('./modules/campaigns/campaign.routes'));

// ---- V3: premium AI ----
// The AI plan catalogue is a separate prefix from `/subscriptions` on purpose.
// `/subscriptions` owns billing - what a shop is paying and when it renews.
// `/subscription-plans` owns what each plan *unlocks* in the AI layer, which is
// Super Admin configuration rather than commerce. Keeping them apart is what
// stopped the two branches' `GET /plans` from colliding on one path.
router.use('/subscription-plans', require('./modules/subscriptions/plan.routes'));
router.use('/ai', require('./modules/ai/ai.routes'));

// ---- V4: Services ----
router.use('/services', require('./modules/services/service.routes'));
router.use('/service-offer-claims', require('./modules/services/serviceOfferClaim.routes'));
router.use('/saved-services', require('./modules/savedServices/savedService.routes'));
router.use('/service-analytics', require('./modules/services/serviceAnalytics.routes'));

module.exports = router;
