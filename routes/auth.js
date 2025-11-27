const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

// ✅ AÑADIR ESTAS IMPORTACIONES
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const authController = require('../controllers/authController');

/**
 * Register Host
 * POST /auth/register-host
 * body: { name, email, password }
 */
router.post('/register-host', authController.registerHost);


/**
 * Get host info by QR code (para página web)
 * GET /auth/host-by-qr/:qrCode
 */
router.get('/host-by-qr/:qrCode', async (req, res) => {
  try {
    const { qrCode } = req.params;
    
    console.log("🔍 Buscando host por QR:", qrCode);
    
    const host = await User.findOne({ qrCode: qrCode, role: 'host' })
      .select('name email _id qrCode');
    
    if (!host) {
      console.log("❌ Host no encontrado para QR:", qrCode);
      return res.status(404).json({ 
        success: false,
        error: 'Host no encontrado' 
      });
    }

    console.log("✅ Host encontrado:", host.name, "ID:", host._id);
    
    res.json({
      success: true,
      host: {
        id: host._id,
        name: host.name,
        email: host.email,
        qrCode: host.qrCode
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo host por QR:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error obteniendo información del host' 
    });
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