const { getWebSocketStats } = require('../websocket');
const AnonymousConversation = require('../models/AnonymousConversation');
const AnonymousMessage = require('../models/AnonymousMessage');

function serializeConversation(conversation) {
  return {
    id: conversation._id?.toString?.() || conversation._id || null,
    conversationId: conversation._id?.toString?.() || conversation._id || null,
    callId: conversation._id?.toString?.() || conversation._id || null,
    guestName: conversation.guestName || 'Visitante',
    status: conversation.status || 'pending',
    response: conversation.response || null,
    lastMessageAt: conversation.lastMessageAt || conversation.createdAt || null,
    lastMessageText: conversation.lastMessageText || null,
    lastMessageSender: conversation.lastMessageSender || null,
    messageCount: Number(conversation.messageCount || 0),
    hostUnreadCount: Number(conversation.hostUnreadCount || 0),
    isAnonymous: conversation.isAnonymous !== false,
    createdAt: conversation.createdAt || null,
    answeredAt: conversation.answeredAt || null,
    expireAt: conversation.expireAt || conversation.timeoutAt || null,
    timeoutAt: conversation.timeoutAt || conversation.expireAt || null,
  };
}

function serializeConversationWithMessage(conversation, message) {
  const base = serializeConversation(conversation);

  return {
    ...base,
    lastMessageId: message?._id?.toString?.() || message?._id || null,
    lastMessageDeliveryStatus: message?.deliveryStatus || null,
    lastMessageDeliveredAt: message?.deliveredAt || null,
    lastMessageReadAt: message?.readAt || null,
  };
}

function getStats(req, res) {
  return res.json({
    success: true,
    stats: {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsage: process.memoryUsage(),
      websocket: getWebSocketStats(),
    },
    timestamp: new Date().toISOString(),
  });
}

async function getHostConversations(req, res) {
  try {
    const conversations = await AnonymousConversation.find({
      hostId: req.user._id,
    })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .lean();

    const conversationIds = conversations.map((conversation) => conversation._id?.toString?.() || conversation._id).filter(Boolean);
    const latestMessages = conversationIds.length > 0
      ? await AnonymousMessage.aggregate([
          { $match: { conversationId: { $in: conversationIds } } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$conversationId',
              message: { $first: '$$ROOT' },
            },
          },
        ])
      : [];

    const latestMessageMap = new Map(
      latestMessages.map((entry) => [entry._id?.toString?.() || entry._id, entry.message]),
    );

    return res.json({
      success: true,
      conversations: conversations.map((conversation) =>
        serializeConversationWithMessage(
          conversation,
          latestMessageMap.get(conversation._id?.toString?.() || conversation._id) || null,
        ),
      ),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No pudimos cargar las conversaciones',
    });
  }
}

module.exports = {
  getHostConversations,
  getStats,
};
