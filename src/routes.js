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

module.exports = router;
