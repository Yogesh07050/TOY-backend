'use strict';

const express = require('express');
const controller = require('./preferences.controller');
const schema = require('./preferences.schema');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate } = require('../../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/', asyncHandler(controller.get));
router.get('/status', asyncHandler(controller.status));
router.post('/', validate({ body: schema.setPreferencesSchema }), asyncHandler(controller.set));
router.put('/', validate({ body: schema.setPreferencesSchema }), asyncHandler(controller.set));

module.exports = router;
