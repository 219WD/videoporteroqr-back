const { randomUUID } = require('crypto');
const AnonymousConversation = require('../models/AnonymousConversation');
const AnonymousMessage = require('../models/AnonymousMessage');
const User = require('../models/User');
const { CHAT_SESSION_TIMEOUT_MS } = require('../config/env');
const { dispatchNotification } = require('../services/pushNotifications');
const { validateMessage, validateName, validateQrCode } = require('../utils/validation');
const { createScopedLogger } = require('../utils/logger');

const log = createScopedLogger('websocket:chat');

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function getSessionExpireAt(now = new Date()) {
  return new Date(now.getTime() + CHAT_SESSION_TIMEOUT_MS).toISOString();
}

function createAbortError(message = 'Request aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isConversationExpired(conversation) {
  const expireAt = conversation?.expireAt || conversation?.timeoutAt || null;

  if (!expireAt) {
    return false;
  }

  const expireAtMs = new Date(expireAt).getTime();
  return Number.isFinite(expireAtMs) && Date.now() >= expireAtMs;
}

function roomForConversation(conversationId) {
  return `conversation:${conversationId}`;
}

function roomForHost(hostId) {
  return `host:${hostId}`;
}

function serializeConversation(conversation) {
  if (!conversation) {
    return null;
  }

  return {
    id: conversation._id?.toString?.() || conversation._id || null,
    conversationId: conversation._id?.toString?.() || conversation._id || null,
    hostId: conversation.hostId?.toString?.() || conversation.hostId || null,
    guestName: conversation.guestName || '',
    qrCode: conversation.qrCode || null,
    actionType: conversation.actionType || 'message',
    status: conversation.status || 'pending',
    messageCount: Number(conversation.messageCount || 0),
    lastMessageAt: conversation.lastMessageAt || null,
    lastMessageText: conversation.lastMessageText || null,
    lastMessageSender: conversation.lastMessageSender || null,
    hostUnreadCount: Number(conversation.hostUnreadCount || 0),
    isAnonymous: conversation.isAnonymous !== false,
    expireAt: conversation.expireAt || conversation.timeoutAt || null,
    timeoutAt: conversation.timeoutAt || conversation.expireAt || null,
    answeredAt: conversation.answeredAt || null,
    response: conversation.response || null,
    createdAt: conversation.createdAt || null,
    updatedAt: conversation.updatedAt || null,
  };
}

function serializeMessage(message) {
  if (!message) {
    return null;
  }

  return {
    id: message._id?.toString?.() || message._id || null,
    conversationId: message.conversationId?.toString?.() || message.conversationId || null,
    sender: message.sender,
    senderName: message.senderName,
    text: message.text,
    deliveryStatus: message.deliveryStatus || 'sent',
    deliveredAt: message.deliveredAt || null,
    readAt: message.readAt || null,
    createdAt: message.createdAt || null,
    updatedAt: message.updatedAt || null,
  };
}

async function loadConversationState(conversationId, signal = null) {
  const [conversation, messages] = await Promise.all([
    AnonymousConversation.findById(conversationId).setOptions({
      signal,
      maxTimeMS: 5000,
    }).lean(),
    AnonymousMessage.find({ conversationId }).sort({ createdAt: 1 }).setOptions({
      signal,
      maxTimeMS: 5000,
    }).lean(),
  ]);

  return {
    conversation: serializeConversation(conversation),
    messages: messages.map(serializeMessage),
  };
}

async function resolveHostFromConversation(conversation, signal = null) {
  const hostId = conversation?.hostId?.toString?.() || conversation?.hostId || null;

  if (!hostId) {
    return null;
  }

  throwIfAborted(signal);

  const host = await User.findById(hostId)
    .select('name email _id qrCode')
    .setOptions({
      signal,
      maxTimeMS: 5000,
    })
    .lean();

  if (!host) {
    return null;
  }

  return {
    id: host._id?.toString?.() || host._id || null,
    name: host.name || null,
    email: host.email || null,
    qrCode: host.qrCode || null,
  };
}

async function ensureConversation({
  conversationId,
  hostId,
  guestName = 'Visitante',
  qrCode = null,
  signal = null,
}) {
  throwIfAborted(signal);

  let conversation = await AnonymousConversation.findById(conversationId).setOptions({
    signal,
    maxTimeMS: 5000,
  });

  if (!conversation) {
    if (!hostId) {
      throw new Error('hostId requerido para crear la conversación');
    }

    const expireAt = getSessionExpireAt();
    conversation = new AnonymousConversation({
      _id: conversationId,
      hostId,
      guestName: normalizeText(guestName) || 'Visitante',
      qrCode: qrCode || conversationId,
      actionType: 'message',
      status: 'pending',
      messageCount: 0,
      lastMessageAt: null,
      lastMessageText: null,
      lastMessageSender: null,
      hostUnreadCount: 0,
      isAnonymous: true,
      expireAt,
      timeoutAt: expireAt,
      answeredAt: null,
      response: null,
    });
  } else {
    if (!conversation.hostId && hostId) {
      conversation.hostId = hostId;
    }

    if (!conversation.guestName && guestName) {
      conversation.guestName = normalizeText(guestName) || 'Visitante';
    }

    if (!conversation.qrCode && qrCode) {
      conversation.qrCode = qrCode;
    }

    if (!conversation.expireAt && !conversation.timeoutAt) {
      conversation.expireAt = getSessionExpireAt();
    }

    if (!conversation.expireAt && conversation.timeoutAt) {
      conversation.expireAt = conversation.timeoutAt;
    }

    if (!conversation.timeoutAt && conversation.expireAt) {
      conversation.timeoutAt = conversation.expireAt;
    }
  }

  await conversation.save(signal ? { signal } : undefined);
  return conversation;
}

async function storeChatMessage({
  conversationId,
  hostId,
  guestName,
  qrCode,
  sender,
  senderName,
  text,
  signal = null,
}) {
  const cleanConversationId = normalizeText(conversationId);
  const cleanSender = normalizeText(sender);
  const cleanSenderName = normalizeText(senderName);
  const cleanText = normalizeText(text);

  if (!cleanConversationId) {
    throw new Error('conversationId requerido');
  }

  if (!['guest', 'host'].includes(cleanSender)) {
    throw new Error('sender requerido');
  }

  if (!cleanSenderName) {
    throw new Error('senderName requerido');
  }

  if (!cleanText) {
    throw new Error('text requerido');
  }

  throwIfAborted(signal);

  const conversation = await ensureConversation({
    conversationId: cleanConversationId,
    hostId,
    guestName,
    qrCode,
    signal,
  });

  if (isConversationExpired(conversation)) {
    conversation.status = 'timeout';
    conversation.response = 'timeout';
    await conversation.save(signal ? { signal } : undefined);
    const timeoutError = new Error('conversation_timeout');
    timeoutError.code = 'conversation_timeout';
    throw timeoutError;
  }

  throwIfAborted(signal);

  const message = new AnonymousMessage({
    conversationId: cleanConversationId,
    sender: cleanSender,
    senderName: cleanSenderName,
    text: cleanText,
    deliveryStatus: 'sent',
    deliveredAt: null,
    readAt: null,
  });

  await message.save(signal ? { signal } : undefined);

  conversation.messageCount = Number(conversation.messageCount || 0) + 1;
  conversation.lastMessageAt = message.createdAt || new Date();
  conversation.lastMessageText = cleanText;
  conversation.lastMessageSender = cleanSender;
  conversation.guestName = normalizeText(guestName) || conversation.guestName || 'Visitante';
  conversation.status = conversation.status || 'pending';

  if (cleanSender === 'guest') {
    conversation.hostUnreadCount = Number(conversation.hostUnreadCount || 0) + 1;
  } else {
    conversation.hostUnreadCount = 0;
  }

  await conversation.save(signal ? { signal } : undefined);

  return {
    conversation: serializeConversation(conversation.toObject()),
    message: serializeMessage(message.toObject()),
  };
}

async function updateMessageDeliveryStatus({
  conversationId,
  messageId,
  status,
  socketId = null,
  signal = null,
}) {
  const cleanConversationId = normalizeText(conversationId);
  const cleanMessageId = normalizeText(messageId);

  if (!cleanConversationId || !cleanMessageId) {
    throw new Error('conversationId y messageId requeridos');
  }

  const message = await AnonymousMessage.findOne({
    _id: cleanMessageId,
    conversationId: cleanConversationId,
  }).setOptions({
    signal,
    maxTimeMS: 5000,
  });

  if (!message) {
    return null;
  }

  const nextStatus = status === 'read' ? 'read' : 'delivered';

  if (nextStatus === 'delivered') {
    if (!message.deliveredAt) {
      message.deliveredAt = new Date();
    }
    if (message.deliveryStatus === 'sent') {
      message.deliveryStatus = 'delivered';
    }
  }

  if (nextStatus === 'read') {
    if (!message.deliveredAt) {
      message.deliveredAt = new Date();
    }
    if (!message.readAt) {
      message.readAt = new Date();
    }
    message.deliveryStatus = 'read';
  }

  await message.save(signal ? { signal } : undefined);

  return serializeMessage(message.toObject());
}

async function findHostByQr(qrCode, signal = null) {
  const cleanQrCode = validateQrCode(qrCode);

  if (!cleanQrCode) {
    return null;
  }

  throwIfAborted(signal);

  return User.findOne({ qrCode: cleanQrCode, role: 'host' })
    .select('name email _id qrCode')
    .setOptions({
      signal,
      maxTimeMS: 5000,
    })
    .lean();
}

async function notifyHostAboutChatStart({ conversation, message }) {
  if (!conversation?.hostId || !message) {
    return null;
  }

  return dispatchNotification({
    userId: conversation.hostId,
    socketEvent: 'chat:session:start',
    title: `Nuevo chat de ${conversation.guestName || 'Visitante'}`,
    body: message.text,
    payload: {
      screen: '/chat/[callId]',
      params: { callId: conversation.conversationId || conversation.id },
      conversationId: conversation.conversationId || conversation.id,
      callId: conversation.conversationId || conversation.id,
      guestName: conversation.guestName || 'Visitante',
      sender: message.sender,
      senderName: message.senderName,
      message: message.text,
      type: 'chat_started',
    },
  });
}

async function notifyHostAboutGuestMessage({ conversation, message }) {
  if (!conversation?.hostId || message?.sender !== 'guest') {
    return null;
  }

  return dispatchNotification({
    userId: conversation.hostId,
    socketEvent: 'chat:message:new',
    title: conversation.guestName || 'Nuevo mensaje',
    body: message.text,
    payload: {
      screen: '/chat/[callId]',
      params: { callId: conversation.conversationId || conversation.id },
      conversationId: conversation.conversationId || conversation.id,
      callId: conversation.conversationId || conversation.id,
      guestName: conversation.guestName || 'Visitante',
      sender: message.sender,
      senderName: message.senderName,
      message: message.text,
      type: 'chat_message',
    },
  });
}

async function startAnonymousChatSession({
  qrCode,
  guestName,
  initialMessage,
  signal = null,
}) {
  const cleanQrCode = validateQrCode(qrCode);
  const cleanGuestName = validateName(guestName);
  const cleanInitialMessage = validateMessage(initialMessage);

  if (!cleanQrCode) {
    throw new Error('No pudimos leer ese QR');
  }

  if (!cleanGuestName) {
    throw new Error('Escribi tu nombre completo');
  }

  if (!cleanInitialMessage) {
    throw new Error('Escribi tu primer mensaje');
  }

  const host = await findHostByQr(cleanQrCode, signal);
  if (!host) {
    const error = new Error('No encontramos al anfitrion para ese QR');
    error.code = 'host_not_found';
    throw error;
  }

  const conversationId = `call-${randomUUID()}`;
  const result = await storeChatMessage({
    conversationId,
    hostId: host._id,
    guestName: cleanGuestName,
    qrCode: cleanQrCode,
    sender: 'guest',
    senderName: cleanGuestName,
    text: cleanInitialMessage,
    signal,
  });

  return {
    conversationId,
    host: {
      id: host._id?.toString?.() || host._id || null,
      name: host.name || null,
      email: host.email || null,
      qrCode: host.qrCode || null,
    },
    ...result,
  };
}

module.exports = {
  findHostByQr,
  loadConversationState,
  notifyHostAboutChatStart,
  notifyHostAboutGuestMessage,
  roomForConversation,
  roomForHost,
  resolveHostFromConversation,
  serializeConversation,
  serializeMessage,
  startAnonymousChatSession,
  updateMessageDeliveryStatus,
  storeChatMessage,
};
