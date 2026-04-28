
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const {
  getAnonymousConversations,
} = require('../controllers/messagesController');

const router = express.Router();

router.get('/anonymous-conversations', authMiddleware, getAnonymousConversations);

module.exports = router;
