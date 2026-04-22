
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const { getIO } = require('../websocket-server');
const { dispatchNotification } = require('../services/pushNotifications');
const { JWT_SECRET } = require('../config/env');
const {
  canUserAccessCall,
  extractGuestToken,
  signGuestToken,
  verifyGuestToken,
} = require('../utils/accessTokens');
const {
  emitCallResponse,
  emitTargetedCallResponse,
  isHostOwner,
  loadCallById,
  markCallResponded,
  toTimedOutSummary,
} = require('../utils/callHelpers');
const { sendError, sendSuccess } = require('../utils/api');
const { validateName, validateQrCode } = require('../utils/validation');

function buildIncomingPayload(call, guestName, guestEmail, extra = {}) {
  return {
    _id: call._id,
    createdAt: call.createdAt,
    guestEmail,
    guestName,
    hostId: call.hostId,
    isAnonymous: false,
    status: 'pending',
    ...extra,
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

async function canAccessVideoCall(req, videoCall) {
  const user = await resolveRequestUser(req);

  if (canUserAccessCall(user, videoCall)) {
    return true;
  }

  const token = extractGuestToken(req);
  const payload = verifyGuestToken(token);
  if (!payload) {
    return false;
  }

  return (
    payload.callId?.toString?.() === videoCall._id.toString() &&
    payload.hostId?.toString?.() === videoCall.hostId.toString()
  );
}

async function startAutomaticCall(req, res) {
  try {
    const { hostId, guestName = 'Visitante', guestEmail = 'anonimo@visitante.com' } = req.body;

    if (!hostId) {
      return sendError(res, 400, 'Host requerido');
    }

    const host = await User.findById(hostId);
    if (!host) {
      return sendError(res, 404, 'Host no encontrado');
    }

    const videoCall = await DoorbellCall.create({
      callType: 'video',
      guestEmail,
      guestId: null,
      guestName,
      hostId: host._id,
      status: 'pending',
    });

    const guestToken = signGuestToken({
      callId: videoCall._id.toString(),
      hostId: host._id.toString(),
      accessScope: 'video',
      guestName,
    });

    const io = getIO();
    io.to(`host-${host._id}`).emit(
      'call-incoming',
      buildIncomingPayload(videoCall, guestName, guestEmail, { isAnonymous: true }),
    );

    await dispatchNotification({
      userId: host._id,
      socketEvent: 'call:invite',
      title: 'Videollamada entrante',
      body: `${guestName} quiere llamarte`,
      categoryId: 'call_invite',
      sendSocket: false,
      payload: {
        callId: videoCall._id.toString(),
        callKind: 'video',
        hostId: host._id.toString(),
        guestName,
        guestEmail,
        screen: '/calls/[callId]',
        params: {
          callId: videoCall._id.toString(),
          role: 'callee',
        },
        type: 'video_call_invite',
      },
      data: {
        type: 'video_call_invite',
        callKind: 'video',
        callId: videoCall._id.toString(),
        hostId: host._id.toString(),
        guestName,
        guestEmail,
        screen: '/calls/[callId]',
        params: {
          callId: videoCall._id.toString(),
          role: 'callee',
        },
      },
    });

    return sendSuccess(res, {
      callId: videoCall._id,
      guestToken,
      hostName: host.name,
      message: 'Llamada iniciada correctamente',
    });
  } catch (error) {
    console.error('Error iniciando videollamada:', error);
    return sendError(res, 500, 'Error iniciando videollamada', { details: error.message });
  }
}

async function acceptCall(req, res) {
  try {
    const { callId } = req.body;
    const videoCall = await loadCallById(DoorbellCall, callId);

    if (!videoCall) {
      return sendError(res, 404, 'Videollamada no encontrada');
    }

    if (!isHostOwner(req.user, videoCall)) {
      return sendError(res, 403, 'No tienes permisos para esta llamada');
    }

    if (videoCall.status !== 'pending') {
      return sendError(res, 400, 'Esta llamada ya fue respondida');
    }

    markCallResponded(videoCall, 'accept');
    await videoCall.save();

    const io = getIO();
    emitTargetedCallResponse(io, `user-${videoCall.guestId}`, { callId, response: 'accept' });
    io.to(callId).emit('call-response', { callId, hostName: req.user.name, response: 'accept' });
    emitCallResponse(io, { callId, response: 'accept' });

    return sendSuccess(res, {
      call: videoCall,
      message: 'Videollamada aceptada',
    });
  } catch (error) {
    console.error('Error aceptando videollamada:', error);
    return sendError(res, 500, 'Error aceptando videollamada');
  }
}

async function rejectCall(req, res) {
  try {
    const { callId } = req.body;
    const videoCall = await loadCallById(DoorbellCall, callId);

    if (!videoCall) {
      return sendError(res, 404, 'Videollamada no encontrada');
    }

    if (!isHostOwner(req.user, videoCall)) {
      return sendError(res, 403, 'No tienes permisos para esta llamada');
    }

    if (videoCall.status !== 'pending') {
      return sendError(res, 400, 'Esta llamada ya fue respondida');
    }

    markCallResponded(videoCall, 'reject');
    await videoCall.save();

    const io = getIO();
    emitTargetedCallResponse(io, `user-${videoCall.guestId}`, { callId, response: 'reject' });
    io.to(callId).emit('call-response', { callId, response: 'reject' });
    emitCallResponse(io, { callId, response: 'reject' });

    return sendSuccess(res, {
      call: videoCall,
      message: 'Videollamada rechazada',
    });
  } catch (error) {
    console.error('Error rechazando videollamada:', error);
    return sendError(res, 500, 'Error rechazando videollamada');
  }
}

async function getCallConfig(req, res) {
  try {
    const { callId } = req.params;
    const videoCall = await loadCallById(DoorbellCall, callId);

    if (!videoCall) {
      return sendError(res, 404, 'Videollamada no encontrada');
    }

    const isHost = req.user._id.toString() === videoCall.hostId.toString();
    const isGuest = videoCall.guestId && req.user._id.toString() === videoCall.guestId.toString();

    if (!isHost && !isGuest) {
      return sendError(res, 403, 'No tienes permisos para esta llamada');
    }

    return sendSuccess(res, {
      call: videoCall,
      userRole: isHost ? 'host' : 'guest',
    });
  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    return sendError(res, 500, 'Error obteniendo configuración');
  }
}

async function anonymousCall(req, res) {
  try {
    const qrCode = validateQrCode(req.body.qrCode);
    const guestName = validateName(req.body.guestName || 'Visitante Web') || 'Visitante Web';

    if (!qrCode) {
      return sendError(res, 400, 'Código QR requerido');
    }

    const host = await User.findOne({ qrCode, role: 'host' });
    if (!host) {
      return sendError(res, 404, 'Host no encontrado');
    }

    const callId = `anon-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const videoCall = await DoorbellCall.create({
      _id: callId,
      callType: 'video',
      guestEmail: 'anonimo@visitante.com',
      guestId: null,
      guestName,
      hostId: host._id,
      isAnonymous: true,
      qrCode,
      status: 'pending',
    });

    const guestToken = signGuestToken({
      callId,
      hostId: host._id.toString(),
      accessScope: 'video',
      guestName,
    });

    const io = getIO();
    io.to(`host-${host._id}`).emit('call-incoming', buildIncomingPayload(videoCall, guestName, 'anonimo@visitante.com', { isAnonymous: true, qrCode }));
    io.emit('new-anonymous-call', {
      callId,
      guestName,
      hostId: host._id.toString(),
      hostName: host.name,
    });

    await dispatchNotification({
      userId: host._id,
      socketEvent: 'call:invite',
      title: 'Videollamada entrante',
      body: `${guestName} te está llamando`,
      categoryId: 'call_invite',
      sendSocket: false,
      payload: {
        callId,
        callKind: 'video',
        hostId: host._id.toString(),
        guestName,
        guestEmail: 'anonimo@visitante.com',
        screen: '/calls/[callId]',
        params: {
          callId,
          role: 'callee',
        },
        type: 'video_call_invite',
      },
      data: {
        type: 'video_call_invite',
        callKind: 'video',
        callId,
        hostId: host._id.toString(),
        guestName,
        guestEmail: 'anonimo@visitante.com',
        screen: '/calls/[callId]',
        params: {
          callId,
          role: 'callee',
        },
      },
    });

    return sendSuccess(res, {
      callId,
      guestToken,
      hostId: host._id,
      hostName: host.name,
      message: 'Llamada iniciada correctamente',
    });
  } catch (error) {
    console.error('Error en llamada anónima:', error);
    return sendError(res, 500, 'Error iniciando videollamada', { details: error.message });
  }
}

async function endCall(req, res) {
  try {
    const { callId } = req.body;

    if (!callId) {
      return sendError(res, 400, 'Call ID requerido');
    }

    const videoCall = await loadCallById(DoorbellCall, callId);
    if (!videoCall) {
      return sendError(res, 404, 'Llamada no encontrada');
    }

    if (!(await canAccessVideoCall(req, videoCall))) {
      return sendError(res, 403, 'No tienes permisos para finalizar esta llamada');
    }

    if (videoCall.status === 'pending') {
      markCallResponded(videoCall, 'timeout');
      await videoCall.save();
    }

    const io = getIO();
    io.to(callId).emit('call-ended');
    io.emit('call-ended', { callId });

    return sendSuccess(res, { message: 'Llamada finalizada' });
  } catch (error) {
    console.error('Error finalizando llamada:', error);
    return sendError(res, 500, 'Error finalizando llamada');
  }
}

async function checkStatus(req, res) {
  try {
    const { callId } = req.params;
    const videoCall = await loadCallById(DoorbellCall, callId);

    if (!videoCall) {
      return sendError(res, 404, 'Llamada no encontrada');
    }

    if (!(await canAccessVideoCall(req, videoCall))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    const { ageMs, isTimedOut } = toTimedOutSummary(videoCall, 30 * 1000);
    if (videoCall.status === 'pending' && isTimedOut) {
      markCallResponded(videoCall, 'timeout');
      await videoCall.save();
    }

    return sendSuccess(res, {
      call: {
        _id: videoCall._id,
        answeredAt: videoCall.answeredAt,
        createdAt: videoCall.createdAt,
        guestName: videoCall.guestName,
        isAnonymous: videoCall.isAnonymous || false,
        response: videoCall.response,
        status: videoCall.status,
      },
    });
  } catch (error) {
    console.error('Error verificando estado:', error);
    return sendError(res, 500, 'Error verificando estado de llamada');
  }
}

async function joinCall(req, res) {
  try {
    const { callId, userRole = 'guest', userId = null } = req.body;

    if (!callId) {
      return sendError(res, 400, 'Call ID requerido');
    }

    const videoCall = await loadCallById(DoorbellCall, callId);
    if (!videoCall) {
      return sendError(res, 404, 'Llamada no encontrada');
    }

    if (userRole === 'guest' && videoCall.status !== 'answered') {
      return sendError(res, 400, 'La llamada no ha sido aceptada aún');
    }

    if (userRole === 'host') {
      const hostId = req.user?._id || userId;
      if (!hostId || hostId.toString() !== videoCall.hostId.toString()) {
        return sendError(res, 403, 'No tienes permisos para unirte como host');
      }
    } else if (!(await canAccessVideoCall(req, videoCall))) {
      return sendError(res, 401, 'Token de acceso requerido');
    }

    return sendSuccess(res, {
      callId,
      hostId: videoCall.hostId,
      message: 'Puedes unirte a la videollamada',
      userRole,
    });
  } catch (error) {
    console.error('Error uniéndose a llamada:', error);
    return sendError(res, 500, 'Error uniéndose a la llamada');
  }
}

module.exports = {
  startAutomaticCall,
  acceptCall,
  rejectCall,
  getCallConfig,
  anonymousCall,
  endCall,
  checkStatus,
  joinCall,
};