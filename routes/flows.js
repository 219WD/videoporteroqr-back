
const express = require('express');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const flowsController = require('../controllers/flowsController');

const router = express.Router();

router.post('/start', flowsController.startFlow);
router.post('/:callId/start-call', flowsController.startAnonymousVideo);
router.post('/continue-message', authMiddleware, roleGuard('host', 'admin'), flowsController.continueMessage);
router.post('/continue-call', authMiddleware, roleGuard('host', 'admin'), flowsController.continueCall);
router.get('/:callId/messages', flowsController.getFlowMessages);
router.post('/:callId/send-message', flowsController.sendFlowMessage);
router.post('/respond', authMiddleware, roleGuard('host', 'admin'), flowsController.respondFlow);
router.get('/status/:callId', flowsController.getFlowStatus);
router.get('/host/:hostId/pending', authMiddleware, roleGuard('host', 'admin'), flowsController.getHostPendingFlows);
router.post('/cancel/:callId', authMiddleware, roleGuard('host', 'admin'), flowsController.cancelFlow);
router.get('/history/:hostId', authMiddleware, roleGuard('host', 'admin'), flowsController.getFlowHistory);

module.exports = router;
