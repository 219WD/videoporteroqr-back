const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const {
  listPushTokens,
  registerPushToken,
} = require('../controllers/notificationsController');

const router = express.Router();

router.post('/push-tokens', registerPushToken);
router.get('/push-tokens', authMiddleware, listPushTokens);

module.exports = router;
