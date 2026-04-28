const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AnonymousConversation = require('../models/AnonymousConversation');
const AnonymousMessage = require('../models/AnonymousMessage');
const { getIO } = require('../websocket-server');
const { JWT_SECRET } = require('../config/env');
const { validateName } = require('../utils/validation');
const {
  extractGuestToken,
  signGuestToken,
  verifyGuestToken,
} = require('../utils/accessTokens');
const { dispatchNotification } = require('../services/pushNotifications');
const { errorJson, logJson } = require('../utils/logging');
const { sendError, sendSuccess } = require('../utils/api');

function getFlowTimeoutMs(actionType) {
  return actionType === 'message' ? 15 * 60 * 1000 : 90 * 1000;
}

function getConversationPayload(conversation) {
  return {
    _id: conversation._id.toString(),
    hostId: conversation.hostId?.toString?.() || conversation.hostId,
    guestName: conversation.guestName,
    qrCode: conversation.qrCode,
    status: conversation.status,
    response: conversation.response ?? null,
    actionType: conversation.actionType,
    isAnonymous: conversation.isAnonymous ?? true,
    createdAt: conversation.createdAt,
    answeredAt: conversation.answeredAt ?? null,
    lastMessageAt: conversation.lastMessageAt ?? null,
    lastMessageText: conversation.lastMessageText ?? null,
    lastMessageSender: conversation.lastMessageSender ?? null,
    hostUnreadCount: conversation.hostUnreadCount ?? 0,
    messageCount: conversation.messageCount ?? 0,
  };
}

function getConversationMessagePayload(message) {
  return {
    id: message._id.toString(),
    sender: message.sender,
    message: message.text,
    timestamp: message.createdAt,
    guestName: message.senderName,
  };
}

function buildConversationNotificationPayload(callId, guestName, message) {
  return {
    type: 'anonymous_conversation_message',
    conversationId: callId,
    callId,
    guestName,
    message,
    screen: '/flows/[callId]',
    params: { callId },
  };
}

async function resolveRequestUser(req) {
  if (req.user) {
    return req.user;
  }

  const header = req.headers?.authorization;
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return User.findById(payload.id).select('_id role name');
  } catch (error) {
    return null;
  }
}

function canUserAccessConversation(user, conversation) {
  if (!user || !conversation) {
    return false;
  }

  const userId = user._id?.toString?.() || user.id?.toString?.() || null;
  const hostId = conversation.hostId?.toString?.() || conversation.hostId || null;
  return !!userId && !!hostId && userId === hostId;
}

function hasConversationGuestAccess(req, conversation) {
  const token = extractGuestToken(req);
  const payload = verifyGuestToken(token);

  if (!payload) {
    return false;
  }

  return (
    payload.callId?.toString?.() === conversation._id.toString() &&
    payload.hostId?.toString?.() === conversation.hostId.toString()
  );
}

async function canAccessConversation(req, conversation) {
  const user = await resolveRequestUser(req);
  if (canUserAccessConversation(user, conversation)) {
    return true;
  }

  return hasConversationGuestAccess(req, conversation);
}

async function loadConversationById(callId) {
  return AnonymousConversation.findById(callId);
}

async function appendConversationMessage(conversation, sender, text, senderName) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }

  const messageDoc = await AnonymousMessage.create({
    conversationId: conversation._id.toString(),
    sender,
    senderName,
    text: trimmed,
  });

  const update = {
    $set: {
      lastMessageAt: messageDoc.createdAt,
      lastMessageText: trimmed,
      lastMessageSender: sender,
      ...(sender === 'host' ? { hostUnreadCount: 0 } : {}),
    },
    $inc: {
      messageCount: 1,
      ...(sender === 'guest' ? { hostUnreadCount: 1 } : {}),
    },
  };

  await AnonymousConversation.updateOne({ _id: conversation._id }, update);
  return messageDoc;
}

function isConversationExpired(conversation) {
  if (!conversation?.timeoutAt) {
    return false;
  }

  const timeoutAt = new Date(conversation.timeoutAt);
  return !Number.isNaN(timeoutAt.getTime()) && timeoutAt.getTime() <= Date.now();
}

function resolveConversationState(conversation) {
  if (!conversation) {
    return conversation;
  }

  if (conversation.status === 'pending' && isConversationExpired(conversation)) {
    conversation.status = 'timeout';
    conversation.response = 'timeout';
    conversation.answeredAt = conversation.answeredAt || new Date();
  }

  return conversation;
}

async function startFlow(req, res) {
  try {
    const {
      qrCode,
      actionType,
      message,
      guestName,
      guestFullName,
      isAnonymous = true,
    } = req.body;

    const resolvedGuestName = validateName(guestFullName || guestName || 'Visitante');

    if (!qrCode) {
      return sendError(res, 400, 'Código QR requerido');
    }

    if (actionType && actionType !== 'message') {
      return sendError(res, 400, 'Tipo de acción inválida');
    }

    if (!resolvedGuestName) {
      return sendError(res, 400, 'Nombre completo requerido');
    }

    const host = await User.findOne({ qrCode, role: 'host' }).select('_id name qrCode');
    if (!host) {
      return sendError(res, 404, 'Host no encontrado');
    }

    const callId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const initialMessage = typeof message === 'string' ? message.trim() : '';
    const timeoutAt = new Date(Date.now() + getFlowTimeoutMs('message'));

    const conversation = await AnonymousConversation.create({
      _id: callId,
      hostId: host._id,
      guestName: resolvedGuestName,
      qrCode,
      actionType: 'message',
      status: 'pending',
      timeoutAt,
      isAnonymous: Boolean(isAnonymous),
      messageCount: initialMessage ? 1 : 0,
      lastMessageAt: initialMessage ? new Date() : null,
      lastMessageText: initialMessage || null,
      lastMessageSender: initialMessage ? 'guest' : null,
      hostUnreadCount: initialMessage ? 1 : 0,
    });

    let initialMessageDoc = null;
    if (initialMessage) {
      initialMessageDoc = await AnonymousMessage.create({
        conversationId: conversation._id.toString(),
        sender: 'guest',
        senderName: resolvedGuestName,
        text: initialMessage,
      });
    }

    const guestToken = signGuestToken({
      callId,
      hostId: host._id.toString(),
      accessScope: 'conversation',
      guestName: resolvedGuestName,
      actionType: 'message',
    }, `${Math.max(1, Math.floor(getFlowTimeoutMs('message') / 1000))}s`);

    const io = getIO();
    const payload = {
      callId,
      guestName: resolvedGuestName,
      actionType: 'message',
      status: 'pending',
      lastMessageAt: conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toISOString() : null,
      lastMessageText: conversation.lastMessageText || null,
      hostUnreadCount: conversation.hostUnreadCount || 0,
      qrCode,
      isAnonymous: true,
    };

    io.to(`user-${host._id}`).emit('anonymous-conversation-updated', payload);
    if (initialMessage) {
      io.to(`user-${host._id}`).emit('new-flow-message', {
        id: initialMessageDoc._id.toString(),
        callId,
        sender: 'guest',
        message: initialMessage,
        timestamp: new Date().toISOString(),
        guestName: resolvedGuestName,
      });
    }

    if (initialMessage) {
      await dispatchNotification({
        userId: host._id,
        socketEvent: 'notification:incoming',
        title: 'Nuevo mensaje anónimo',
        body: `${resolvedGuestName}: ${initialMessage.substring(0, 120)}`,
        payload: buildConversationNotificationPayload(callId, resolvedGuestName, initialMessage),
        data: buildConversationNotificationPayload(callId, resolvedGuestName, initialMessage),
      });
    }

    return sendSuccess(res, {
      callId,
      guestToken,
      hostId: host._id,
      hostName: host.name,
      actionType: 'message',
      guestData: {
        name: resolvedGuestName,
        dataProvided: resolvedGuestName !== 'Visitante',
      },
      message: 'Conversación iniciada correctamente',
    });
  } catch (error) {
    errorJson('[flows:start:error]', error);
    return sendError(res, 500, 'Error iniciando conversación');
  }
}

async function continueMessage(req, res) {
  try {
    const { callId } = req.body;
    const conversation = await loadConversationById(callId);
    if (!conversation) {
      return sendError(res, 404, 'Conversación no encontrada');
    }

    if (!canUserAccessConversation(req.user, conversation)) {
      return sendError(res, 403, 'No autorizado');
    }

    return sendSuccess(res, {
      callId,
      guestName: conversation.guestName,
      messageContent: conversation.lastMessageText,
      status: conversation.status,
    });
  } catch (error) {
    errorJson('[flows:continue-message:error]', error);
    return sendError(res, 500, 'Error continuando conversación');
  }
}

async function getFlowMessages(req, res) {
  try {
    const { callId } = req.params;
    const conversation = resolveConversationState(await loadConversationById(callId));

    if (!conversation) {
      return sendError(res, 404, 'Conversación no encontrada');
    }

    if (!(await canAccessConversation(req, conversation))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    if (conversation.status === 'timeout') {
      await conversation.save();
    }

    const messages = await AnonymousMessage.find({ conversationId: callId }).sort({ createdAt: 1 });

    return sendSuccess(res, {
      call: getConversationPayload(conversation),
      messages: messages.map(getConversationMessagePayload),
      timeoutIn: conversation.timeoutAt ? Math.max(0, new Date(conversation.timeoutAt).getTime() - Date.now()) : 0,
    });
  } catch (error) {
    errorJson('[flows:get-messages:error]', error);
    return sendError(res, 500, 'Error obteniendo mensajes');
  }
}

async function sendFlowMessage(req, res) {
  try {
    const { callId } = req.params;
    const { message, sender = 'guest' } = req.body;
    const conversation = resolveConversationState(await loadConversationById(callId));

    if (!conversation) {
      return sendError(res, 404, 'Conversación no encontrada');
    }

    if (!(await canAccessConversation(req, conversation))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return sendError(res, 400, 'Mensaje requerido');
    }

    const senderName = sender === 'host' ? (req.user?.name || 'Host') : (conversation.guestName || 'Visitante');
    const messageDoc = await appendConversationMessage(conversation, sender, message, senderName);
    const updatedConversation = resolveConversationState(await loadConversationById(callId));

    const payload = {
      id: messageDoc._id.toString(),
      callId,
      sender,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      guestName: updatedConversation?.guestName || conversation.guestName,
    };

    const io = getIO();
    io.to(`flow-${callId}`).emit('new-flow-message', payload);
    io.to(`user-${conversation.hostId}`).emit('new-flow-message', payload);
    io.to(`user-${conversation.hostId}`).emit('anonymous-conversation-updated', {
      callId,
      guestName: updatedConversation?.guestName || conversation.guestName,
      status: updatedConversation?.status || conversation.status,
      response: updatedConversation?.response ?? conversation.response,
      lastMessageAt: payload.timestamp,
      lastMessageText: payload.message,
      lastMessageSender: sender,
      hostUnreadCount: sender === 'guest' ? updatedConversation?.hostUnreadCount || 0 : 0,
      isAnonymous: true,
    });

    if (sender === 'guest') {
      const guestMessage = message.trim();
      await dispatchNotification({
        userId: conversation.hostId,
        socketEvent: 'notification:incoming',
        title: 'Nuevo mensaje anónimo',
        body: `${conversation.guestName || 'Visitante'}: ${guestMessage.substring(0, 120)}`,
        payload: buildConversationNotificationPayload(
          callId,
          conversation.guestName || 'Visitante',
          guestMessage,
        ),
        data: buildConversationNotificationPayload(
          callId,
          conversation.guestName || 'Visitante',
          guestMessage,
        ),
      });
    }

    return sendSuccess(res, {
      callId,
      messages: await AnonymousMessage.find({ conversationId: callId })
        .sort({ createdAt: 1 })
        .then((items) => items.map(getConversationMessagePayload)),
    });
  } catch (error) {
    errorJson('[flows:send-message:error]', error);
    return sendError(res, 500, 'Error enviando mensaje');
  }
}

async function respondFlow(req, res) {
  try {
    const { callId, response, hostMessage } = req.body;
    const conversation = resolveConversationState(await loadConversationById(callId));

    if (!conversation) {
      return sendError(res, 404, 'Conversación no encontrada');
    }

    if (!canUserAccessConversation(req.user, conversation)) {
      return sendError(res, 403, 'No autorizado');
    }

    if (!['accept', 'reject', 'timeout'].includes(response)) {
      return sendError(res, 400, 'Respuesta inválida');
    }

    conversation.status = response === 'reject' ? 'rejected' : response === 'timeout' ? 'timeout' : 'answered';
    conversation.response = response;
    conversation.answeredAt = new Date();

    if (hostMessage && String(hostMessage).trim()) {
      await appendConversationMessage(conversation, 'host', hostMessage, req.user?.name || 'Host');
    }

    await conversation.save();

    const responseData = {
      callId,
      response,
      hostMessage: hostMessage || null,
      timestamp: new Date().toISOString(),
      call: getConversationPayload(conversation),
    };

    const io = getIO();
    io.to(`flow-${callId}`).emit('flow-response', responseData);
    io.to(`user-${conversation.hostId}`).emit('flow-response', responseData);
    io.to(`user-${conversation.hostId}`).emit('anonymous-conversation-updated', {
      callId,
      guestName: conversation.guestName,
      status: conversation.status,
      response: conversation.response,
      answeredAt: conversation.answeredAt,
      isAnonymous: true,
    });

    return sendSuccess(res, {
      callId,
      response,
      call: getConversationPayload(conversation),
    });
  } catch (error) {
    errorJson('[flows:respond:error]', error);
    return sendError(res, 500, 'Error respondiendo conversación');
  }
}

async function getFlowStatus(req, res) {
  try {
    const { callId } = req.params;
    const conversation = resolveConversationState(await loadConversationById(callId));

    if (!conversation) {
      return sendError(res, 404, 'Conversación no encontrada');
    }

    if (!(await canAccessConversation(req, conversation))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    if (conversation.status === 'timeout') {
      await conversation.save();
    }

    return sendSuccess(res, {
      call: getConversationPayload(conversation),
      timeoutIn: conversation.timeoutAt ? Math.max(0, new Date(conversation.timeoutAt).getTime() - Date.now()) : 0,
    });
  } catch (error) {
    errorJson('[flows:get-status:error]', error);
    return sendError(res, 500, 'Error obteniendo estado');
  }
}

async function getHostPendingFlows(req, res) {
  try {
    const hostId = req.user._id;
    const conversations = await AnonymousConversation.find({
      hostId,
      status: 'pending',
    }).sort({ createdAt: -1 });

    return sendSuccess(res, {
      conversations: conversations.map(getConversationPayload),
      count: conversations.length,
    });
  } catch (error) {
    errorJson('[flows:get-pending:error]', error);
    return sendError(res, 500, 'Error obteniendo conversaciones pendientes');
  }
}

async function cancelFlow(req, res) {
  try {
    const { callId } = req.params;
    const conversation = await loadConversationById(callId);
    if (!conversation) {
      return sendError(res, 404, 'Conversación no encontrada');
    }

    if (!canUserAccessConversation(req.user, conversation)) {
      return sendError(res, 403, 'No autorizado');
    }

    conversation.status = 'rejected';
    conversation.response = 'reject';
    conversation.answeredAt = new Date();
    await conversation.save();

    const responseData = {
      callId,
      response: 'reject',
      timestamp: new Date().toISOString(),
    };

    const io = getIO();
    io.to(`flow-${callId}`).emit('flow-response', responseData);
    io.to(`user-${conversation.hostId}`).emit('flow-response', responseData);

    return sendSuccess(res, {
      callId,
      call: getConversationPayload(conversation),
    });
  } catch (error) {
    errorJson('[flows:cancel:error]', error);
    return sendError(res, 500, 'Error cancelando conversación');
  }
}

async function getFlowHistory(req, res) {
  try {
    const targetHostId = req.params.hostId || req.user._id;
    const conversations = await AnonymousConversation.find({ hostId: targetHostId }).sort({ createdAt: -1 });

    return sendSuccess(res, {
      conversations: conversations.map(getConversationPayload),
      total: conversations.length,
    });
  } catch (error) {
    errorJson('[flows:get-history:error]', error);
    return sendError(res, 500, 'Error obteniendo historial');
  }
}

module.exports = {
  cancelFlow,
  continueMessage,
  getFlowHistory,
  getFlowMessages,
  getFlowStatus,
  getHostPendingFlows,
  respondFlow,
  sendFlowMessage,
  startFlow,
};
