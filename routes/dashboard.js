
const express = require('express');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const dashboardController = require('../controllers/dashboardController');
const qrManagementController = require('../controllers/qrManagementController');

const router = express.Router();

router.get('/admin/hosts', authMiddleware, roleGuard('admin'), dashboardController.getAdminHosts);
router.get('/admin/users', authMiddleware, roleGuard('admin'), dashboardController.getAdminUsers);
router.get('/admin/stats', authMiddleware, roleGuard('admin'), dashboardController.getAdminStats);
router.get('/qr/status', authMiddleware, roleGuard('host', 'admin'), qrManagementController.getMyAssetStatus);
router.patch('/qr/status', authMiddleware, roleGuard('host'), qrManagementController.updateMyQrStatus);
router.patch('/qr/visitor-settings', authMiddleware, roleGuard('host'), qrManagementController.updateVisitorSettings);
router.post('/qr/report', authMiddleware, roleGuard('host'), qrManagementController.createUserReport);

module.exports = router;
