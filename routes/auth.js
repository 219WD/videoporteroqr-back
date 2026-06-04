
const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.post('/register', authController.registerHost);
router.get('/qr', authMiddleware, authController.getMyQr);
router.get('/host-by-qr/:qrCode', authController.getHostByQr);
router.post('/login', authController.login);
router.get('/me', authMiddleware, authController.getMe);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-email-otp', authController.resendEmailOtp);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

module.exports = router;
