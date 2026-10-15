
const express = require('express');
const authController = require('../controllers/authController');
const { authMiddleware } = require('../middleware/auth');
const { forgotPasswordBanMiddleware } = require('../middleware/securityBan');
const { auditMiddleware } = require('../middleware/auditLogger');

const router = express.Router();

router.post('/register', authController.registerHost);
router.get('/qr', authMiddleware, authController.getMyQr);
router.get('/host-by-qr/:qrCode', authController.getHostByQr);
router.post('/login', authController.login);
router.get('/me', authMiddleware, authController.getMe);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-email-otp', authController.resendEmailOtp);

// Máximo 5 solicitudes de código por mail en 24h (por IP y por email).
// Baneo temporal con TTL de 24h en MongoDB. No hay baneo por usar el código.
router.post(
  '/forgot-password',
  forgotPasswordBanMiddleware,
  authController.forgotPassword
);

// Auditar cada intento de uso del código de recuperación
router.post(
  '/reset-password',
  auditMiddleware('reset_password_attempt', 'allowed'),
  authController.resetPassword
);

module.exports = router;
