
const express = require('express');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const videocallController = require('../controllers/videocallController');

const router = express.Router();

router.post('/start-automatic', videocallController.startAutomaticCall);
router.post('/accept-call', authMiddleware, roleGuard('host'), videocallController.acceptCall);
router.post('/reject-call', authMiddleware, roleGuard('host'), videocallController.rejectCall);
router.get('/config/:callId', authMiddleware, videocallController.getCallConfig);
router.post('/anonymous-call', videocallController.anonymousCall);
router.post('/end-call', videocallController.endCall);
router.get('/check-status/:callId', videocallController.checkStatus);
router.post('/join-call', videocallController.joinCall);

module.exports = router;
