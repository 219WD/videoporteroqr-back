
const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middleware/auth');
const { otpSecurityMiddleware } = require('../middleware/securityBan');

const router = express.Router();

router.post('/register', authController.registerHost);
router.get('/qr', authMiddleware, authController.getMyQr);
router.get('/host-by-qr/:qrCode', authController.getHostByQr);
router.post('/login', authController.login);
router.get('/me', authMiddleware, authController.getMe);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-email-otp', authController.resendEmailOtp);

// Solicitud de código de recuperación: máximo 5 en 24h por IP y por email.
// Al superar el umbral se banea el email y todas sus IPs relacionadas (TTL 24h).
router.post(
  '/forgot-password',
  otpSecurityMiddleware('forgot_password'),
  authController.forgotPassword
);

// Validar código de recuperación: solo verifica si la IP o el email ya están baneados.
router.post(
  '/reset-password',
  otpSecurityMiddleware('reset_password'),
  authController.resetPassword
);

module.exports = router;
