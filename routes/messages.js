
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const {
  getAnonymousConversations,
  getContacts,
  getConversations,
  getConversation,
  markConversationReadHandler,
  resolveConversation,
  sendMessage,
} = require('../controllers/messagesController');

const router = express.Router();

router.get('/contacts', authMiddleware, getContacts);
router.get('/conversations', authMiddleware, getConversations);
router.get('/anonymous-conversations', authMiddleware, getAnonymousConversations);
router.post('/conversations/resolve', authMiddleware, resolveConversation);
router.get('/conversations/:conversationId', authMiddleware, getConversation);
router.post('/conversations/:conversationId/messages', authMiddleware, sendMessage);
router.post('/conversations/:conversationId/read', authMiddleware, markConversationReadHandler);

module.exports = router;
