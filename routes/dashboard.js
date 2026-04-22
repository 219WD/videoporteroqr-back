
const express = require('express');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const dashboardController = require('../controllers/dashboardController');

const router = express.Router();

router.get('/host/guests', authMiddleware, roleGuard('host'), dashboardController.getHostGuests);
router.get('/admin/hosts', authMiddleware, roleGuard('admin'), dashboardController.getAdminHosts);
router.get('/admin/guests', authMiddleware, roleGuard('admin'), dashboardController.getAdminGuests);
router.get('/admin/stats', authMiddleware, roleGuard('admin'), dashboardController.getAdminStats);

module.exports = router;
