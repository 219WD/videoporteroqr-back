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
 * Get host info by QR code (para página web)
 * GET /auth/get-host-by-qr?code=XXX
 */
router.get('/get-host-by-qr', async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: 'Código QR requerido' });
    }

    console.log("🔍 Buscando host por QR:", code);
    
    const host = await User.findOne({ qrCode: code, role: 'host' })
      .select('name email _id');
    
    if (!host) {
      console.log("❌ Host no encontrado para QR:", code);
      return res.status(404).json({ error: 'Host no encontrado' });
    }

    console.log("✅ Host encontrado:", host.name, "ID:", host._id);
    
    res.json({
      success: true,
      hostId: host._id,
      hostName: host.name,
      hostEmail: host.email
    });

  } catch (error) {
    console.error('❌ Error obteniendo host por QR:', error);
    res.status(500).json({ error: 'Error obteniendo información del host' });
  }
});


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