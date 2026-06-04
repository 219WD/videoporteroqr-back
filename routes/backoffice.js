const express = require('express');
const backofficeController = require('../controllers/backofficeController');
const { authMiddleware, roleGuard } = require('../middleware/auth');

const router = express.Router();

router.get('/users', authMiddleware, roleGuard('admin'), backofficeController.getUsers);
router.get('/users/:userId/qr.png', authMiddleware, roleGuard('admin'), backofficeController.getUserQrPng);

module.exports = router;
