
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const {
  acceptCallSession,
  createCallSession,
  endCallSession,
  getCallHistory,
  getCallSession,
  rejectCallSession,
} = require('../controllers/callsController');

const router = express.Router();

router.use(authMiddleware);

router.post('/sessions', createCallSession);
router.get('/sessions/:callId', getCallSession);
router.post('/sessions/:callId/accept', acceptCallSession);
router.post('/sessions/:callId/reject', rejectCallSession);
router.post('/sessions/:callId/end', endCallSession);
router.get('/history', getCallHistory);

module.exports = router;
