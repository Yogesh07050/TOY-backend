'use strict';

const express = require('express');
const controller = require('./shop.controller');
const schema = require('./shop.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, optionalAuth } = require('../../middleware/auth');
const {
  requireGlobalPermission,
  requireShopScope,
  loadShop,
} = require('../../middleware/authorize');

const router = express.Router();

// The shop detail route accepts an id or a slug, so it is not validated as an int.
router.get('/', optionalAuth, validate({ query: schema.listShopsSchema }), asyncHandler(controller.list));
router.get('/:id', optionalAuth, asyncHandler(controller.detail));

// ---- Shop CRUD - creation and deletion are Super Admin territory (§16) -----
router.post(
  '/',
  authenticate,
  requireGlobalPermission('CREATE_SHOP'),
  validate({ body: schema.shopBody }),
  asyncHandler(controller.create),
);

router.put(
  '/:id',
  authenticate,
  validate({ params: schema.idParam, body: schema.updateShopSchema }),
  loadShop(),
  requireShopScope('EDIT_SHOP', 'id'),
  asyncHandler(controller.update),
);

router.delete(
  '/:id',
  authenticate,
  requireGlobalPermission('DELETE_SHOP'),
  validate({ params: schema.idParam }),
  loadShop(),
  asyncHandler(controller.remove),
);

// ---- Branches (§17) --------------------------------------------------------
router.get('/:id/branches', optionalAuth, validate({ params: schema.idParam }), asyncHandler(controller.listBranches));

router.post(
  '/:id/branches',
  authenticate,
  validate({ params: schema.idParam, body: schema.branchBody }),
  requireShopScope('MANAGE_LOCATIONS', 'id'),
  asyncHandler(controller.createBranch),
);

router.put(
  '/:id/branches/:branchId',
  authenticate,
  validate({ params: schema.branchParams, body: schema.updateBranchSchema }),
  requireShopScope('MANAGE_LOCATIONS', 'id'),
  asyncHandler(controller.updateBranch),
);

router.delete(
  '/:id/branches/:branchId',
  authenticate,
  validate({ params: schema.branchParams }),
  requireShopScope('MANAGE_LOCATIONS', 'id'),
  asyncHandler(controller.deactivateBranch),
);

// ---- Members (§18) ---------------------------------------------------------
router.get(
  '/:id/members',
  authenticate,
  validate({ params: schema.idParam }),
  // Deliberately not VIEW_SHOP: customers hold that globally, which would
  // expose every shop's member roster (names, emails) to any signed-in user.
  requireShopScope('VIEW_SHOP_MEMBERS', 'id'),
  asyncHandler(controller.listMembers),
);

router.post(
  '/:id/members',
  authenticate,
  validate({ params: schema.idParam, body: schema.memberBody }),
  requireShopScope('MANAGE_SHOP_MEMBERS', 'id'),
  asyncHandler(controller.addMember),
);

router.put(
  '/:id/members/:memberId',
  authenticate,
  validate({ params: schema.memberParams, body: schema.updateMemberSchema }),
  requireShopScope('MANAGE_SHOP_MEMBERS', 'id'),
  asyncHandler(controller.updateMember),
);

router.delete(
  '/:id/members/:memberId',
  authenticate,
  validate({ params: schema.memberParams }),
  requireShopScope('MANAGE_SHOP_MEMBERS', 'id'),
  asyncHandler(controller.removeMember),
);

module.exports = router;
