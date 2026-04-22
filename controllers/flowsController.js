
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const AnonymousConversation = require('../models/AnonymousConversation');
const AnonymousMessage = require('../models/AnonymousMessage');
const { getIO } = require('../websocket-server');
const { JWT_SECRET } = require('../config/env');
const { parsePositiveInt, validateHostId, validateName } = require('../utils/validation');
const {
  extractGuestToken,
  isUserOwnerOfHost,
  signGuestToken,
  verifyGuestToken,
} = require('../utils/accessTokens');
const { dispatchNotification } = require('../services/pushNotifications');
const {
  appendCallMessage,
  emitCallResponse,
  emitTargetedCallResponse,
  isHostOwner,
  loadCallById,
  markCallResponded,
  toTimedOutSummary,
} = require('../utils/callHelpers');
const { sendError, sendSuccess } = require('../utils/api');

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

function resolveHostActorId(req, fallbackHostId = null) {
  if (req.user?.role === 'admin') {
    return validateHostId(req.body?.hostId || req.params?.hostId || fallbackHostId);
  }

  return req.user?._id ? req.user._id.toString() : null;
}

function getFlowTimeoutMs(actionType) {
  return actionType === 'message' ? 15 * 60 * 1000 : 90 * 1000;
}

function buildAnonymousVideoJoinUrl(callId, guestToken = null) {
  const tokenQuery = guestToken ? `?token=${encodeURIComponent(guestToken)}` : '';
  return `/call/${callId}${tokenQuery}`;
}

async function createAnonymousConversation({
  callId,
  hostId,
  guestName,
  qrCode,
  actionType,
  message,
}) {
  const timeoutAt = new Date(Date.now() + getFlowTimeoutMs(actionType));

  const conversation = await AnonymousConversation.findOneAndUpdate(
    { _id: callId },
    {
      $set: {
        hostId,
        guestName,
        qrCode,
        actionType,
        status: 'pending',
        timeoutAt,
        isAnonymous: true,
      },
      $setOnInsert: {
        _id: callId,
        createdAt: new Date(),
      },
    },
    {
      new: true,
      upsert: true,
    },
  );

  if (message && String(message).trim()) {
    await AnonymousMessage.create({
      conversationId: callId,
      sender: 'guest',
      senderName: guestName,
      text: String(message).trim(),
    });

    await AnonymousConversation.updateOne(
      { _id: callId },
      {
        $set: {
          lastMessageAt: new Date(),
          lastMessageText: String(message).trim(),
          lastMessageSender: 'guest',
        },
        $inc: {
          messageCount: 1,
          hostUnreadCount: 1,
        },
      },
    );
  }

  return conversation;
}

async function appendAnonymousConversationMessage({
  callId,
  sender,
  senderName,
  text,
}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }

  const messageDoc = await AnonymousMessage.create({
    conversationId: callId,
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

  await AnonymousConversation.updateOne(
    { _id: callId },
    update,
  );

  return messageDoc;
}

function isFlowExpired(flow) {
  if (!flow) {
    return false;
  }

  const expiresAt = flow.timeoutAt ? new Date(flow.timeoutAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return false;
  }

  return expiresAt.getTime() <= Date.now();
}

function ensureFlowExpired(flow) {
  if (!flow || flow.status !== 'pending' || !isFlowExpired(flow)) {
    return false;
  }

  markCallResponded(flow, 'timeout');
  flow.status = 'timeout';
  flow.response = 'timeout';
  return true;
}

function hasFlowGuestAccess(req, doorbellCall) {
  const token = extractGuestToken(req);
  const payload = verifyGuestToken(token);

  if (!payload) {
    return false;
  }

  return (
    payload.callId?.toString?.() === doorbellCall._id.toString() &&
    payload.hostId?.toString?.() === doorbellCall.hostId.toString()
  );
}

async function canAccessFlow(req, doorbellCall) {
  const user = await resolveRequestUser(req);

  if (user && isHostOwner(user, doorbellCall)) {
    return true;
  }

  return hasFlowGuestAccess(req, doorbellCall);
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

    console.log('🚀 Iniciando flujo simplificado:', {
      qrCode, actionType, guestName: resolvedGuestName, isAnonymous,
    });

    if (!qrCode) {
      return res.status(400).json({
        success: false,
        error: 'Código QR requerido',
      });
    }

    if (!actionType || !['message', 'call'].includes(actionType)) {
      return res.status(400).json({
        success: false,
        error: 'Tipo de acción inválida',
      });
    }

    if (!resolvedGuestName) {
      return res.status(400).json({
        success: false,
        error: 'Nombre completo requerido',
      });
    }

    const host = await User.findOne({ qrCode, role: 'host' });
    if (!host) {
      return res.status(404).json({
        success: false,
        error: 'Host no encontrado',
      });
    }

    const callId = `flow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const doorbellCall = await DoorbellCall.create({
      _id: callId,
      hostId: host._id,
      guestName: resolvedGuestName,
      status: 'pending',
      callType: actionType === 'call' ? 'video' : 'message',
      actionType,
      messageContent: message,
      qrCode,
      isAnonymous,
      guestDataProvided: resolvedGuestName !== 'Visitante',
      firstNotificationAt: new Date(),
      timeoutAt: new Date(Date.now() + getFlowTimeoutMs(actionType)),
      messages: message ? [{
        sender: 'guest',
        message,
        timestamp: new Date(),
      }] : [],
    });

    await createAnonymousConversation({
      callId,
      hostId: host._id,
      guestName: resolvedGuestName,
      qrCode,
      actionType,
      message,
    });

    const guestToken = signGuestToken({
      callId,
      hostId: host._id.toString(),
      accessScope: 'flow',
      guestName: resolvedGuestName,
      actionType,
    }, `${Math.max(1, Math.floor(getFlowTimeoutMs(actionType) / 1000))}s`);

    const io = getIO();
    const notificationData = {
      type: 'initial',
      actionType,
      callId,
      guestName: resolvedGuestName,
      isAnonymous,
      requiresAction: true,
      timestamp: new Date().toISOString(),
      ...(actionType === 'call'
        ? {
          title: '📞 Videollamada entrante',
          message: `${resolvedGuestName} quiere iniciar una videollamada`,
        }
        : {
          title: '📝 Mensaje nuevo',
          messagePreview: message ? `${message.substring(0, 100)}...` : null,
          fullMessage: message,
        }),
    };

    io.to(`host-${host._id}`).emit('flow-incoming', notificationData);
    io.to(`user-${host._id}`).emit('anonymous-conversation-updated', {
      callId,
      guestName: resolvedGuestName,
      actionType,
      status: 'pending',
      lastMessageAt: new Date().toISOString(),
      lastMessageText: message || null,
      hostUnreadCount: message ? 1 : 0,
      qrCode,
    });

    await dispatchNotification({
      userId: host._id,
      socketEvent: 'notification:incoming',
      title: actionType === 'call' ? 'Llamada entrante' : 'Nuevo mensaje anónimo',
      body: actionType === 'call'
        ? `${resolvedGuestName} quiere videollamarte`
        : (message ? `${resolvedGuestName}: ${message.substring(0, 120)}` : `${resolvedGuestName} te envió un mensaje`),
      payload: {
        ...notificationData,
        type: actionType === 'call' ? 'anonymous_flow_call' : 'anonymous_flow_message',
        screen: '/flows/[callId]',
        params: {
          callId,
        },
      },
      data: {
        ...notificationData,
        type: actionType === 'call' ? 'anonymous_flow_call' : 'anonymous_flow_message',
        screen: '/flows/[callId]',
        params: {
          callId,
        },
      },
    });

    return res.json({
      success: true,
      callId,
      guestToken,
      actionType,
      hostId: host._id,
      hostName: host.name,
      guestData: {
        name: resolvedGuestName,
        dataProvided: resolvedGuestName !== 'Visitante',
      },
      message: 'Flujo iniciado correctamente',
    });
  } catch (error) {
    console.error('❌ Error iniciando flujo:', error);
    return res.status(500).json({
      success: false,
      error: 'Error iniciando flujo',
      details: error.message,
    });
  }
}

async function continueMessage(req, res) {
  try {
    const { callId } = req.body;
    const cleanHostId = resolveHostActorId(req);

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      return sendError(res, 404, 'Flujo no encontrado');
    }

    if (!cleanHostId || !isHostOwner({ _id: cleanHostId }, doorbellCall)) {
      return sendError(res, 403, 'No autorizado');
    }

    if (doorbellCall.actionType !== 'message') {
      return sendError(res, 400, 'Este flujo no es de tipo mensaje');
    }

    const io = getIO();
    const notificationData = {
      type: 'message_details',
      callId,
      guestName: doorbellCall.guestName,
      fullMessage: doorbellCall.messageContent,
      urgency: 'medium',
      requiresResponse: true,
      timestamp: new Date().toISOString(),
    };

    io.to(`host-${cleanHostId}`).emit('flow-message-details', notificationData);

    doorbellCall.secondNotificationAt = new Date();
    await doorbellCall.save();

    return sendSuccess(res, {
      message: 'Detalles del mensaje enviados al host',
      callId,
      guestName: doorbellCall.guestName,
      messageContent: doorbellCall.messageContent,
    });
  } catch (error) {
    console.error('❌ Error continuando flujo de mensaje:', error);
    return sendError(res, 500, 'Error continuando flujo');
  }
}

async function continueCall(req, res) {
  try {
    const { callId } = req.body;
    const cleanHostId = resolveHostActorId(req);

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      return sendError(res, 404, 'Flujo no encontrado');
    }

    if (!cleanHostId || !isHostOwner({ _id: cleanHostId }, doorbellCall)) {
      return sendError(res, 403, 'No autorizado');
    }

    if (doorbellCall.actionType !== 'call') {
      return sendError(res, 400, 'Este flujo no es de tipo llamada');
    }

    const io = getIO();
    const notificationData = {
      type: 'start_videocall',
      callId,
      guestName: doorbellCall.guestName,
      urgency: 'high',
      requiresAnswer: true,
      timestamp: new Date().toISOString(),
      webUrl: buildAnonymousVideoJoinUrl(callId),
    };

    io.to(`host-${cleanHostId}`).emit('flow-start-videocall', notificationData);

    doorbellCall.secondNotificationAt = new Date();
    doorbellCall.callType = 'video';
    await doorbellCall.save();

    const callRooms = io.getCallRooms ? io.getCallRooms() : null;
    if (callRooms) {
      callRooms.set(callId, {
        hostId: cleanHostId,
        guestId: doorbellCall.guestId || null,
        actionType: 'video_call',
        status: 'pending',
        createdAt: new Date(),
      });
    }

    return sendSuccess(res, {
      callId,
      message: 'Videollamada iniciada',
      webUrl: buildAnonymousVideoJoinUrl(callId),
      socketEvent: 'flow-start-videocall',
    });
  } catch (error) {
    console.error('❌ Error continuando flujo de llamada:', error);
    return sendError(res, 500, 'Error iniciando videollamada');
  }
}

async function startAnonymousVideo(req, res) {
  try {
    const { callId } = req.params;

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      return sendError(res, 404, 'Flujo no encontrado');
    }

    if (!(await canAccessFlow(req, doorbellCall))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    if (ensureFlowExpired(doorbellCall)) {
      await doorbellCall.save();
      return sendError(res, 410, 'El chat expiro');
    }

    doorbellCall.actionType = 'call';
    doorbellCall.callType = 'video';
    doorbellCall.status = 'pending';
    doorbellCall.response = null;
    doorbellCall.timeoutAt = new Date(Date.now() + getFlowTimeoutMs('call'));
    await doorbellCall.save();

    await AnonymousConversation.updateOne(
      { _id: callId },
      {
        $set: {
          actionType: 'call',
          status: 'pending',
          response: null,
          timeoutAt: doorbellCall.timeoutAt,
        },
      },
    );

    const guestToken = signGuestToken({
      callId,
      hostId: doorbellCall.hostId.toString(),
      accessScope: 'flow',
      guestName: doorbellCall.guestName,
      actionType: 'call',
    }, `${Math.max(1, Math.floor(getFlowTimeoutMs('call') / 1000))}s`);

    const io = getIO();
    const notificationData = {
      type: 'start_videocall',
      callId,
      guestName: doorbellCall.guestName,
      urgency: 'high',
      requiresAnswer: true,
      timestamp: new Date().toISOString(),
      webUrl: buildAnonymousVideoJoinUrl(callId, guestToken),
    };

    io.to(`host-${doorbellCall.hostId}`).emit('flow-start-videocall', notificationData);
    io.to(`user-${doorbellCall.hostId}`).emit('anonymous-conversation-updated', {
      callId,
      guestName: doorbellCall.guestName,
      actionType: 'call',
      status: 'pending',
      response: null,
      lastMessageAt: new Date().toISOString(),
      lastMessageText: doorbellCall.messageContent || null,
      hostUnreadCount: 0,
      qrCode: doorbellCall.qrCode,
    });

    await dispatchNotification({
      userId: doorbellCall.hostId,
      socketEvent: 'notification:incoming',
      title: 'Videollamada entrante',
      body: `${doorbellCall.guestName} quiere videollamarte`,
      payload: {
        ...notificationData,
        type: 'anonymous_flow_call',
        screen: '/flows/[callId]',
        params: {
          callId,
        },
      },
      data: {
        ...notificationData,
        type: 'anonymous_flow_call',
        screen: '/flows/[callId]',
        params: {
          callId,
        },
      },
    });

    return sendSuccess(res, {
      callId,
      guestToken,
      hostId: doorbellCall.hostId,
      hostName: (await User.findById(doorbellCall.hostId).select('name'))?.name || null,
      webUrl: buildAnonymousVideoJoinUrl(callId, guestToken),
      message: 'Videollamada preparada',
    });
  } catch (error) {
    console.error('âŒ Error iniciando videollamada anÃ³nima:', error);
    return sendError(res, 500, 'Error iniciando videollamada');
  }
}

async function getFlowMessages(req, res) {
  try {
    const { callId } = req.params;

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado',
      });
    }

    let anonymousConversation = await AnonymousConversation.findById(callId);
    if (!anonymousConversation) {
      anonymousConversation = await createAnonymousConversation({
        callId,
        hostId: doorbellCall.hostId,
        guestName: doorbellCall.guestName,
        qrCode: doorbellCall.qrCode || '',
        actionType: doorbellCall.actionType === 'call' ? 'call' : 'message',
        message: doorbellCall.messageContent || null,
      });
    }

    if (!(await canAccessFlow(req, doorbellCall))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    if (ensureFlowExpired(doorbellCall)) {
      await doorbellCall.save();
      await AnonymousConversation.updateOne(
        { _id: callId },
        {
          $set: {
            status: 'timeout',
            response: 'timeout',
          },
        },
      );
      return sendError(res, 410, 'El chat expiro');
    }

    const messages = await AnonymousMessage.find({ conversationId: callId })
      .sort({ createdAt: 1 });

    return res.json({
      success: true,
      call: {
        _id: doorbellCall._id,
        guestName: doorbellCall.guestName,
        guestEmail: doorbellCall.guestEmail,
        guestPhone: doorbellCall.guestPhone,
        guestCompany: doorbellCall.guestCompany,
        isAnonymous: doorbellCall.isAnonymous,
        guestDataProvided: doorbellCall.guestDataProvided,
        createdAt: doorbellCall.createdAt,
        status: doorbellCall.status,
        actionType: doorbellCall.actionType,
        hostUnreadCount: anonymousConversation.hostUnreadCount || 0,
      },
      messages: messages.map((message) => ({
        sender: message.sender,
        message: message.text,
        timestamp: message.createdAt,
        guestName: message.senderName,
      })),
      totalMessages: messages.length,
    });
  } catch (error) {
    console.error('❌ Error obteniendo mensajes:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo mensajes',
    });
  }
}

async function sendFlowMessage(req, res) {
  try {
    const { callId } = req.params;
    const { message, sender = 'guest' } = req.body;

    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Mensaje requerido',
      });
    }

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      return sendError(res, 404, 'Flujo no encontrado');
    }

    if (!(await canAccessFlow(req, doorbellCall))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    if (ensureFlowExpired(doorbellCall)) {
      await doorbellCall.save();
      return sendError(res, 410, 'El chat expiro');
    }

    let anonymousConversation = await AnonymousConversation.findById(callId);
    if (!anonymousConversation) {
      anonymousConversation = await createAnonymousConversation({
        callId,
        hostId: doorbellCall.hostId,
        guestName: doorbellCall.guestName,
        qrCode: doorbellCall.qrCode || '',
        actionType: doorbellCall.actionType === 'call' ? 'call' : 'message',
        message: null,
      });
    }

    appendCallMessage(doorbellCall, sender, message);
    await doorbellCall.save();

    await appendAnonymousConversationMessage({
      callId,
      sender,
      senderName: sender === 'host' ? (req.user?.name || 'Host') : (doorbellCall.guestName || 'Visitante'),
      text: message,
    });

    const io = getIO();
    const payload = {
      callId,
      sender,
      message,
      timestamp: new Date().toISOString(),
      guestName: doorbellCall.guestName,
    };

    io.to(`host-${doorbellCall.hostId}`).emit('new-flow-message', {
      ...payload,
    });

    io.to(`flow-${callId}`).emit('new-flow-message', payload);
    io.to(`user-${doorbellCall.hostId}`).emit('new-flow-message', payload);
    if (anonymousConversation) {
      io.to(`user-${doorbellCall.hostId}`).emit('anonymous-conversation-updated', {
        callId,
        guestName: doorbellCall.guestName,
        actionType: doorbellCall.actionType,
        status: doorbellCall.status,
        response: doorbellCall.response,
        lastMessageAt: payload.timestamp,
        lastMessageText: message,
        lastMessageSender: sender,
        hostUnreadCount: sender === 'guest' ? 1 : 0,
      });
    }

    if (sender !== 'host') {
      await dispatchNotification({
        userId: doorbellCall.hostId,
        socketEvent: 'notification:incoming',
        title: doorbellCall.guestName || 'Nuevo mensaje anónimo',
        body: message.substring(0, 120),
        payload: {
          ...payload,
          type: 'anonymous_flow_message',
          screen: '/flows/[callId]',
          params: {
            callId,
          },
        },
        data: {
          ...payload,
          type: 'anonymous_flow_message',
          screen: '/flows/[callId]',
          params: {
            callId,
          },
        },
      });
    }

    return sendSuccess(res, {
      message: 'Mensaje enviado correctamente',
      callId,
      messages: doorbellCall.messages,
      totalMessages: doorbellCall.messages.length,
    });
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error);
    return sendError(res, 500, 'Error enviando mensaje');
  }
}

async function respondFlow(req, res) {
  try {
    const { callId, response, hostMessage } = req.body;

    if (!callId || !response) {
      return res.status(400).json({
        success: false,
        error: 'Call ID y respuesta son requeridos',
      });
    }

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      return sendError(res, 404, 'Flujo no encontrado');
    }

    if (!isHostOwner(req.user, doorbellCall)) {
      return sendError(res, 403, 'No autorizado');
    }

    markCallResponded(doorbellCall, response);

    if (hostMessage) {
      appendCallMessage(doorbellCall, 'host', hostMessage);
      await appendAnonymousConversationMessage({
        callId,
        sender: 'host',
        senderName: req.user?.name || 'Host',
        text: hostMessage,
      });
    }

    await doorbellCall.save();

    await AnonymousConversation.updateOne(
      { _id: callId },
      {
        $set: {
          status: doorbellCall.status,
          response: doorbellCall.response,
          answeredAt: doorbellCall.answeredAt || null,
        },
      },
    );

    const io = getIO();
    const responseData = {
      callId,
      response,
      hostMessage,
      timestamp: new Date().toISOString(),
    };

    io.to(`flow-${callId}`).emit('flow-response', responseData);
    io.to(`user-${doorbellCall.hostId}`).emit('flow-response', responseData);
    if (hostMessage) {
      io.to(`flow-${callId}`).emit('new-flow-message', {
        callId,
        sender: 'host',
        message: hostMessage,
        timestamp: new Date().toISOString(),
        guestName: doorbellCall.guestName,
      });
      io.to(`user-${doorbellCall.hostId}`).emit('new-flow-message', {
        callId,
        sender: 'host',
        message: hostMessage,
        timestamp: new Date().toISOString(),
        guestName: doorbellCall.guestName,
      });
      io.to(`user-${doorbellCall.hostId}`).emit('anonymous-conversation-updated', {
        callId,
        guestName: doorbellCall.guestName,
        actionType: doorbellCall.actionType,
        status: doorbellCall.status,
        response: doorbellCall.response,
        lastMessageAt: new Date().toISOString(),
        lastMessageText: hostMessage,
        lastMessageSender: 'host',
        hostUnreadCount: 0,
      });
    }

    if (response === 'accept' && doorbellCall.actionType === 'call') {
      io.to(`flow-${callId}`).emit('flow-host-accepted', {
        callId,
        message: 'El anfitrión aceptó la videollamada',
        joinUrl: buildAnonymousVideoJoinUrl(callId),
      });
      io.to(`user-${doorbellCall.hostId}`).emit('flow-host-accepted', {
        callId,
        message: 'El anfitrión aceptó la videollamada',
        joinUrl: buildAnonymousVideoJoinUrl(callId),
      });
    }

    return sendSuccess(res, {
      message: `Respuesta ${response === 'accept' ? 'aceptada' : 'rechazada'} enviada`,
      call: doorbellCall,
      notificationSent: true,
    });
  } catch (error) {
    console.error('❌ Error respondiendo al flujo:', error);
    return sendError(res, 500, 'Error enviando respuesta');
  }
}

async function getFlowStatus(req, res) {
  try {
    const { callId } = req.params;

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      return sendError(res, 404, 'Flujo no encontrado');
    }

    if (!(await canAccessFlow(req, doorbellCall))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    const effectiveTimeoutMs = getFlowTimeoutMs(doorbellCall.actionType);
    const { ageMs, isTimedOut, timeoutIn } = toTimedOutSummary(doorbellCall, effectiveTimeoutMs);

    if (doorbellCall.status === 'pending' && isTimedOut) {
      markCallResponded(doorbellCall, 'timeout');
      await doorbellCall.save();
    }

    const host = await User.findById(doorbellCall.hostId).select('name email');

    return sendSuccess(res, {
      call: {
        _id: doorbellCall._id,
        hostId: doorbellCall.hostId,
        guestName: doorbellCall.guestName,
        status: doorbellCall.status,
        response: doorbellCall.response,
        actionType: doorbellCall.actionType,
        callType: doorbellCall.callType,
        messageContent: doorbellCall.messageContent,
        isAnonymous: doorbellCall.isAnonymous,
        createdAt: doorbellCall.createdAt,
        answeredAt: doorbellCall.answeredAt,
        messages: doorbellCall.messages,
      },
      host,
      elapsedSeconds: Math.floor(ageMs / 1000),
      timeoutIn,
      isTimedOut: isTimedOut && doorbellCall.status === 'pending',
    });
  } catch (error) {
    console.error('❌ Error obteniendo estado del flujo:', error);
    return sendError(res, 500, 'Error obteniendo estado');
  }
}

async function getHostPendingFlows(req, res) {
  try {
    const { hostId } = req.params;
    const targetHostId = resolveHostActorId(req, hostId);

    if (!targetHostId) {
      return sendError(res, 401, 'Autenticación requerida');
    }

    if (req.user?.role !== 'admin' && !isUserOwnerOfHost(req.user, targetHostId)) {
      return sendError(res, 403, 'No autorizado');
    }

    const pendingFlows = await DoorbellCall.find({
      hostId: targetHostId,
      status: 'pending',
      createdAt: { $gte: new Date(Date.now() - Math.max(getFlowTimeoutMs('call'), getFlowTimeoutMs('message'))) },
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: pendingFlows.length,
      flows: pendingFlows.map((flow) => ({
        _id: flow._id,
        guestName: flow.guestName,
        actionType: flow.actionType,
        callType: flow.callType,
        messageContent: flow.messageContent ? `${flow.messageContent.substring(0, 100)}...` : null,
        createdAt: flow.createdAt,
        elapsedSeconds: Math.floor((new Date() - new Date(flow.createdAt)) / 1000),
        isAnonymous: flow.isAnonymous,
      })),
    });
  } catch (error) {
    console.error('❌ Error obteniendo flujos pendientes:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo flujos pendientes',
    });
  }
}

async function cancelFlow(req, res) {
  try {
    const { callId } = req.params;

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado',
      });
    }

    if (!isHostOwner(req.user, doorbellCall)) {
      return sendError(res, 403, 'No autorizado');
    }

    doorbellCall.status = 'rejected';
    doorbellCall.response = 'timeout';
    doorbellCall.answeredAt = new Date();
    await doorbellCall.save();

    const io = getIO();
    io.emit('flow-cancelled', {
      callId,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Flujo cancelado',
      callId,
    });
  } catch (error) {
    console.error('❌ Error cancelando flujo:', error);
    res.status(500).json({
      success: false,
      error: 'Error cancelando flujo',
    });
  }
}

async function getFlowHistory(req, res) {
  try {
    const { hostId } = req.params;
    const targetHostId = resolveHostActorId(req, hostId);

    if (!targetHostId) {
      return sendError(res, 401, 'Autenticación requerida');
    }

    if (req.user?.role !== 'admin' && !isUserOwnerOfHost(req.user, targetHostId)) {
      return sendError(res, 403, 'No autorizado');
    }
    const page = parsePositiveInt(req.query.page, 1, { max: 10000 });
    const limit = parsePositiveInt(req.query.limit, 50, { max: 100 });
    const skip = (page - 1) * limit;

    const flows = await DoorbellCall.find({ hostId: targetHostId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await DoorbellCall.countDocuments({ hostId: targetHostId });

    res.json({
      success: true,
      flows,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('❌ Error obteniendo historial:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo historial',
    });
  }
}

module.exports = {
  startFlow,
  continueMessage,
  continueCall,
  startAnonymousVideo,
  getFlowMessages,
  sendFlowMessage,
  respondFlow,
  getFlowStatus,
  getHostPendingFlows,
  cancelFlow,
  getFlowHistory,
}