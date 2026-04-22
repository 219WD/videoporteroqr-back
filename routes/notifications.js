
// routes/notifications.js - VERSIÃ“N COMPLETA CORREGIDA (CON HISTORIAL)
const express = require('express');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const {
  callHost,
  deleteCall,
  exportHistory,
  getCallHistory,
  getCallStatus,
  getPendingCalls,
  getStatistics,
  listPushTokens,
  markOldTimeout,
  registerPushToken,
  respondCall,
  searchHistory,
} = require('../controllers/notificationsController');

const router = express.Router();

router.post('/push-tokens', registerPushToken);
router.get('/push-tokens', authMiddleware, listPushTokens);
router.post('/call-host', callHost);
router.get('/pending-calls', authMiddleware, roleGuard('host'), getPendingCalls);
router.post('/respond-call', authMiddleware, roleGuard('host'), respondCall);
router.post('/mark-old-timeout', authMiddleware, roleGuard('host'), markOldTimeout);
router.get('/call-history', authMiddleware, getCallHistory);
router.get('/call-status/:callId', authMiddleware, getCallStatus);
router.get('/search-history', authMiddleware, roleGuard('host'), searchHistory);
router.get('/statistics', authMiddleware, roleGuard('host'), getStatistics);
router.get('/export-history', authMiddleware, roleGuard('host'), exportHistory);
router.delete('/delete-call/:callId', authMiddleware, roleGuard('host'), deleteCall);

module.exports = router;
