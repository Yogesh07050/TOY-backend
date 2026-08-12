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
router.use('/reviews', require('./modules/reviews/review.routes'));
router.use('/notifications', require('./modules/notifications/notification.routes'));
router.use('/analytics', require('./modules/analytics/analytics.routes'));
router.use('/audit-logs', require('./modules/audit/audit.routes'));
router.use('/uploads', require('./modules/uploads/upload.routes'));

// ---- V2 ----
router.use('/banners', require('./modules/banners/banner.routes'));
router.use('/discovery', require('./modules/discovery/discovery.routes'));
router.use('/claims', require('./modules/claims/claim.routes'));

// ---- V3 ----
router.use('/subscriptions', require('./modules/subscriptions/subscription.routes'));
router.use('/campaigns', require('./modules/campaigns/campaign.routes'));

module.exports = router;
