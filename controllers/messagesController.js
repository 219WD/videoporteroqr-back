const AnonymousConversation = require('../models/AnonymousConversation');

function formatAnonymousConversation(conversation) {
  return {
    id: conversation._id.toString(),
    conversationId: conversation._id.toString(),
    callId: conversation._id.toString(),
    guestName: conversation.guestName || 'Visitante',
    status: conversation.status || 'pending',
    response: conversation.response ?? null,
    lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt,
    lastMessageText: conversation.lastMessageText || null,
    lastMessageSender: conversation.lastMessageSender || null,
    messageCount: conversation.messageCount || 0,
    hostUnreadCount: conversation.hostUnreadCount || 0,
    isAnonymous: true,
    createdAt: conversation.createdAt || null,
    answeredAt: conversation.answeredAt || null,
  };
}

async function getAnonymousConversations(req, res) {
  try {
    const hostId = req.user?._id;
    if (!hostId) {
      return res.status(401).json({ error: 'Autenticacion requerida' });
    }

    const conversations = await AnonymousConversation.find({ hostId })
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 });

    return res.json({
      conversations: conversations.map(formatAnonymousConversation),
    });
  } catch (error) {
    console.error('Error loading anonymous conversations:', error);
    return res.status(500).json({ error: 'No se pudieron cargar las conversaciones anonimas' });
  }
}

module.exports = {
  getAnonymousConversations,
};
