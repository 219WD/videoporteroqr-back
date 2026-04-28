
const express = require('express');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const dashboardController = require('../controllers/dashboardController');

const router = express.Router();

router.get('/admin/hosts', authMiddleware, roleGuard('admin'), dashboardController.getAdminHosts);
router.get('/admin/stats', authMiddleware, roleGuard('admin'), dashboardController.getAdminStats);

module.exports = router;
