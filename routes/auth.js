const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

// Importar controladores
const authController = require('../controllers/authController');

/**
 * Register Host
 * POST /auth/register-host
 * body: { name, email, password }
 */
router.post('/register-host', authController.registerHost);

/**
 * Register Guest (via QR)
 * POST /auth/register-guest?code=XXXX
 * body: { name, email, password? } (password optional)
 */
router.post('/register-guest', authController.registerGuest);

/**
 * Login (all roles)
 * POST /auth/login { email, password }
 * returns { token, user: {...} }
 */
router.post('/login', authController.login);

/**
 * Get current user
 * GET /auth/me
 * header: Authorization: Bearer token
 */
router.get('/me', authMiddleware, authController.getMe);

/**
 * Register push token
 * POST /auth/register-push-token { pushToken }
 */
router.post('/register-push-token', authMiddleware, authController.registerPushToken);

/**
 * Save push token for current user (host)
 * POST /auth/save-push-token { pushToken }
 */
router.post('/save-push-token', authMiddleware, authController.savePushToken);

/**
 * Join existing guest to host via QR code
 * POST /auth/join-host?code=XXX
 * header: Authorization: Bearer token
 */
router.post('/join-host', authMiddleware, authController.joinHost);

/**
 * Leave current host
 * POST /auth/leave-host
 * header: Authorization: Bearer token
 */
router.post('/leave-host', authMiddleware, authController.leaveHost);

module.exports = router;