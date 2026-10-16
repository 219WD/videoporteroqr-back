const express = require('express');
const backofficeController = require('../controllers/backofficeController');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const qrManagementController = require('../controllers/qrManagementController');

const router = express.Router();

router.get('/users', authMiddleware, roleGuard('admin'), backofficeController.getUsers);
router.patch('/users/:userId/role', authMiddleware, roleGuard('admin'), backofficeController.updateUserRole);
router.get('/users/:userId/qr.png', authMiddleware, roleGuard('admin', 'plate_manager'), backofficeController.getUserQrPng);
router.get('/qr-reports', authMiddleware, roleGuard('admin'), qrManagementController.listReports);
router.patch('/qr-reports/:reportId', authMiddleware, roleGuard('admin'), qrManagementController.updateReport);
router.get('/plate-requests', authMiddleware, roleGuard('admin', 'plate_manager', 'technician'), qrManagementController.listPlateRequests);
router.patch('/plate-requests/:requestId', authMiddleware, roleGuard('admin', 'plate_manager'), qrManagementController.updatePlateRequest);
router.patch('/plate-requests/:requestId/claim', authMiddleware, roleGuard('technician'), qrManagementController.claimPlateRequest);
router.patch('/users/:userId/:asset-status', authMiddleware, roleGuard('admin'), (req, res) => {
  req.params.asset = req.params['asset-status'];
  return qrManagementController.updateUserAssetStatus(req, res);
});

module.exports = router;
