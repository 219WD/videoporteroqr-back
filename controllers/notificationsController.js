
// routes/notifications.js - VERSIÓN COMPLETA CORREGIDA (CON HISTORIAL)
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const { getIO } = require('../websocket-server');
const {
  emitCallResponse,
  emitTargetedCallResponse,
  isHostOwner,
  isCallParticipant,
  loadCallById,
  markCallResponded,
  toCallSummary,
  toTimedOutSummary,
} = require('../utils/callHelpers');
const { sendError, sendSuccess } = require('../utils/api');
const { parsePositiveInt } = require('../utils/validation');
const {
  dispatchNotification,
  listPushTokensForUser,
  upsertPushToken,
} = require('../services/pushNotifications');

async function resolveOptionalUser(req) {
  const header = req.headers.authorization;

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new Error('Token inválido');
  }

  const payload = jwt.verify(token, JWT_SECRET);
  const user = await User.findById(payload.id);

  if (!user) {
    throw new Error('Usuario inválido');
  }

  return user;
}

function serializePushToken(token) {
  return {
    id: token._id,
    token: token.token,
    user: token.user || null,
    deviceId: token.deviceId || null,
    platform: token.platform,
    expoProjectId: token.expoProjectId || null,
    appVersion: token.appVersion || null,
    enabled: token.enabled,
    lastSeenAt: token.lastSeenAt,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

async function registerPushToken(req, res) {
  try {
    const user = await resolveOptionalUser(req);
    const expoPushToken = req.body.expoPushToken || req.body.token;

    if (!expoPushToken || typeof expoPushToken !== 'string') {
      return sendError(res, 400, 'Expo push token requerido');
    }

    const pushToken = await upsertPushToken({
      expoPushToken,
      userId: user?._id || null,
      deviceId: req.body.deviceId || null,
      platform: req.body.platform || 'unknown',
      expoProjectId: req.body.expoProjectId || null,
      appVersion: req.body.appVersion || null,
      metadata: req.body.metadata || {},
      enabled: req.body.enabled !== false,
    });

    return sendSuccess(res, {
      message: user ? 'Token vinculado al usuario' : 'Token registrado de forma anónima',
      pushToken: serializePushToken(pushToken),
    });
  } catch (error) {
    if (
      error.name === 'TokenExpiredError' ||
      error.name === 'JsonWebTokenError' ||
      error.message === 'Token inválido' ||
      error.message === 'Usuario inválido'
    ) {
      return sendError(res, 401, 'Token inválido');
    }

    console.error('Error registrando push token:', error);
    return sendError(res, 500, 'Error registrando push token');
  }
}

async function listPushTokens(req, res) {
  try {
    const isAdmin = req.user.role === 'admin';
    const userId = isAdmin && req.query.userId ? req.query.userId : req.user._id;
    const tokens = await listPushTokensForUser(userId);

    return sendSuccess(res, {
      tokens: tokens.map(serializePushToken),
      count: tokens.length,
    });
  } catch (error) {
    console.error('Error obteniendo push tokens:', error);
    return sendError(res, 500, 'Error obteniendo push tokens');
  }
}

/**
 * Visitor calls host (doorbell) - guarda en DB
 * POST /notifications/call-host
 */
async function callHost(req, res) {
  try {
    const { hostId, guestName = 'Visitante', guestEmail = 'anonimo@visitante.com' } = req.body;

    if (!hostId) {
      return sendError(res, 400, 'Host requerido');
    }

    const host = await User.findById(hostId);
    if (!host) {
      return sendError(res, 404, 'Host no encontrado');
    }

    const doorbellCall = await DoorbellCall.create({
      guestId: null,
      guestEmail,
      guestName,
      hostId: host._id,
      status: 'pending',
    });

    console.log(`🚪 Doorbell: ${guestName} llamó a ${host.name}`, {
      callId: doorbellCall._id,
      timestamp: new Date().toISOString()
    });

    await dispatchNotification({
      userId: host._id,
      socketEvent: 'call:invite',
      title: 'Llamada entrante',
      body: `${guestName} quiere comunicarse contigo`,
      payload: {
        ...toCallSummary(doorbellCall),
        guestEmail,
        guestName,
        hostId: host._id,
        type: 'call_invite',
        screen: '/calls/[callId]',
        params: {
          callId: doorbellCall._id,
          role: 'callee',
        },
      },
      data: {
        callId: doorbellCall._id.toString(),
        hostId: host._id.toString(),
        guestEmail,
        guestName,
        type: 'call_invite',
        screen: '/calls/[callId]',
        params: {
          callId: doorbellCall._id.toString(),
          role: 'callee',
        },
      },
    });

    return sendSuccess(res, {
      callId: doorbellCall._id,
      hostName: host.name,
      message: 'Llamada enviada al host',
    });

  } catch (error) {
    console.error('Error calling host:', error);
    return sendError(res, 500, 'Error al llamar al host');
  }
}

/**
 * Host gets pending calls - MEJORADO con más logs
 * GET /notifications/pending-calls
 */
async function getPendingCalls(req, res) {
  try {
    const hostId = req.user._id;

    console.log(`🔍 Buscando llamadas pendientes para host: ${req.user.name} (${hostId})`);

    // Buscar TODAS las llamadas pendientes (sin límite de tiempo)
    const pendingCalls = await DoorbellCall.find({
      hostId: hostId,
      status: 'pending'
    }).sort({ createdAt: -1 });

    console.log(`🔔 Encontradas ${pendingCalls.length} llamadas pendientes`);

    // Formatear respuesta
    const formattedCalls = pendingCalls.map(call => ({
      _id: call._id,
      guestName: call.guestName,
      guestEmail: call.guestEmail,
      createdAt: call.createdAt,
      isAnonymous: call.isAnonymous || false,
      callType: call.callType || 'doorbell',
      guestId: call.guestId
    }));

    res.json({
      success: true,
      calls: formattedCalls,
      count: pendingCalls.length
    });

  } catch (error) {
    console.error('❌ Error getting pending calls:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo llamadas pendientes'
    });
  }
}

/**
 * Host responds to doorbell call - CORREGIDO
 * POST /notifications/respond-call
 */
async function respondCall(req, res) {
  try {
    const { callId, response } = req.body; // response: 'accept' or 'reject'

    console.log(`🔔 Respondiendo llamada: ${callId}, respuesta: ${response}`);

    if (!callId || !response) {
      return sendError(res, 400, 'Datos incompletos');
    }

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      console.log(`❌ Llamada no encontrada: ${callId}`);
      return sendError(res, 404, 'Llamada no encontrada');
    }

    if (!isHostOwner(req.user, doorbellCall)) {
      console.log(`❌ Permiso denegado: ${doorbellCall.hostId} vs ${req.user._id}`);
      return sendError(res, 403, 'Esta llamada no pertenece a tu sala');
    }

    if (doorbellCall.status !== 'pending') {
      console.log(`❌ Llamada ya respondida: ${doorbellCall.status}`);
      return sendError(res, 400, 'Esta llamada ya fue respondida');
    }

    markCallResponded(doorbellCall, response);
    await doorbellCall.save();

    console.log(`✅ Llamada ${callId} marcada como ${response}`);

    const io = getIO();
    emitCallResponse(io, { callId, response, hostName: req.user.name });

    if (doorbellCall.isAnonymous) {
      emitTargetedCallResponse(io, callId, {
        callId,
        response,
      });
    }

    if (doorbellCall.guestId) {
      emitTargetedCallResponse(io, `user-${doorbellCall.guestId}`, {
        callId,
        response,
      });
    }

    return sendSuccess(res, {
      call: doorbellCall,
      message: `Respuesta ${response === 'accept' ? 'aceptada' : 'rechazada'} enviada`,
    });

  } catch (error) {
    console.error('❌ Error responding to call:', error);
    return sendError(res, 500, 'Error al responder la llamada');
  }
}

/**
 * Mark old pending calls as timeout (NO ELIMINA - SOLO CAMBIA ESTADO)
 * POST /notifications/mark-old-timeout
 */
async function markOldTimeout(req, res) {
  try {
    const hostId = req.user._id;

    // Marcar como timeout llamadas pendientes con más de 1 HORA
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const result = await DoorbellCall.updateMany(
      {
        hostId: hostId,
        status: 'pending',
        createdAt: { $lt: oneHourAgo }
      },
      {
        $set: {
          status: 'timeout',
          response: 'timeout',
          timeoutReason: 'auto_timeout_after_1h',
          answeredAt: new Date() // Marcar como respondida ahora
        }
      }
    );

    console.log(`⏰ Marcadas ${result.modifiedCount} llamadas antiguas como timeout (NO eliminadas)`);

    res.json({
      success: true,
      message: `Completado: ${result.modifiedCount} llamadas marcadas como timeout`,
      details: 'Los registros se mantienen en el historial'
    });

  } catch (error) {
    console.error('Error marking old calls as timeout:', error);
    res.status(500).json({
      success: false,
      error: 'Error procesando llamadas antiguas'
    });
  }
}

/**
 * Get call history for host (CON PAGINACIÓN Y FILTROS)
 * GET /notifications/call-history
 */
async function getCallHistory(req, res) {
  try {
    const isAdmin = req.user.role === 'admin';
    const hostId = isAdmin ? (req.query.hostId || null) : req.user._id;
    const {
      status, // Opcional: 'pending', 'answered', 'timeout', 'all'
      startDate,
      endDate
    } = req.query;
    const page = parsePositiveInt(req.query.page, 1, { max: 10000 });
    const limit = parsePositiveInt(req.query.limit, 20, { max: 100 });

    // Construir filtro
    const filter = hostId ? { hostId } : {};

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const calls = await DoorbellCall.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip((page - 1) * limit);

    const total = await DoorbellCall.countDocuments(filter);

    // Estadísticas adicionales
    const stats = await DoorbellCall.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Totales por tipo de respuesta
    const totals = {
      pending: await DoorbellCall.countDocuments({ ...filter, status: 'pending' }),
      answered: await DoorbellCall.countDocuments({ ...filter, status: 'answered' }),
      timeout: await DoorbellCall.countDocuments({ ...filter, status: 'timeout' }),
      accepted: await DoorbellCall.countDocuments({
        ...filter,
        status: 'answered',
        response: 'accept'
      }),
      rejected: await DoorbellCall.countDocuments({
        ...filter,
        status: 'answered',
        response: 'reject'
      })
    };

    res.json({
      success: true,
      calls,
      pagination: {
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        totalCalls: total,
        limit
      },
      statistics: stats.reduce((acc, curr) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {}),
      totals: totals,
      summary: {
        totalAnswered: totals.answered,
        answerRate: total > 0 ? ((totals.answered / total) * 100).toFixed(1) + '%' : '0%',
        acceptanceRate: totals.answered > 0 ?
          ((totals.accepted / totals.answered) * 100).toFixed(1) + '%' : '0%'
      }
    });

  } catch (error) {
    console.error('Error getting call history:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo historial'
    });
  }
}

/**
 * Get call status for guest
 * GET /notifications/call-status/:callId
 */
async function getCallStatus(req, res) {
  try {
    const { callId } = req.params;

    console.log(`🔍 Buscando estado de llamada: ${callId}`);

    const doorbellCall = await loadCallById(DoorbellCall, callId);
    if (!doorbellCall) {
      console.log(`❌ Llamada no encontrada: ${callId}`);
      return sendError(res, 404, 'Llamada no encontrada');
    }

    const isGuest = isCallParticipant(req.user, doorbellCall) && doorbellCall.guestId && req.user._id.toString() === doorbellCall.guestId.toString();
    const isHost = isHostOwner(req.user, doorbellCall);

    if (!isGuest && !isHost) {
      return sendError(res, 403, 'No tienes permisos para esta llamada');
    }

    if (isGuest && doorbellCall.status === 'pending') {
      const { ageMs, isTimedOut } = toTimedOutSummary(doorbellCall, 30 * 1000);
      if (isTimedOut) {
        console.log(`⏰ Llamada ${callId} marcada como timeout automáticamente (${ageMs}ms)`);
        markCallResponded(doorbellCall, 'timeout');
        await doorbellCall.save();
      }
    }

    console.log(`✅ Estado de llamada: ${doorbellCall.status}`);

    return sendSuccess(res, {
      call: doorbellCall,
      userRole: isHost ? 'host' : 'guest',
    });

  } catch (error) {
    console.error('❌ Error getting call status:', error);
    return sendError(res, 500, 'Error obteniendo estado de llamada');
  }
}

/**
 * Search in call history
 * GET /notifications/search-history
 */
async function searchHistory(req, res) {
  try {
    const hostId = req.user._id;
    const { q, status, dateFrom, dateTo } = req.query;

    const filter = { hostId: hostId };

    // Búsqueda por texto
    if (q) {
      filter.$or = [
        { guestName: { $regex: q, $options: 'i' } },
        { guestEmail: { $regex: q, $options: 'i' } },
        { _id: { $regex: q, $options: 'i' } }
      ];
    }

    // Filtrar por status
    if (status && status !== 'all') {
      filter.status = status;
    }

    // Filtrar por fecha
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    const calls = await DoorbellCall.find(filter)
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({
      success: true,
      count: calls.length,
      calls: calls,
      searchParams: { q, status, dateFrom, dateTo }
    });

  } catch (error) {
    console.error('Error searching history:', error);
    res.status(500).json({
      success: false,
      error: 'Error buscando en historial'
    });
  }
}

/**
 * Get full statistics for dashboard
 * GET /notifications/statistics
 */
async function getStatistics(req, res) {
  try {
    const hostId = req.user._id;

    // Totales por día (últimos 7 días)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const dailyStats = await DoorbellCall.aggregate([
      {
        $match: {
          hostId: hostId,
          createdAt: { $gte: sevenDaysAgo }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
          },
          total: { $sum: 1 },
          answered: {
            $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] }
          },
          accepted: {
            $sum: { $cond: [{ $eq: ["$response", "accept"] }, 1, 0] }
          }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    // Estadísticas generales
    const totalCalls = await DoorbellCall.countDocuments({ hostId: hostId });
    const answeredCalls = await DoorbellCall.countDocuments({
      hostId: hostId,
      status: 'answered'
    });
    const acceptedCalls = await DoorbellCall.countDocuments({
      hostId: hostId,
      response: 'accept'
    });
    const anonymousCalls = await DoorbellCall.countDocuments({
      hostId: hostId,
      isAnonymous: true
    });

    // Última llamada
    const lastCall = await DoorbellCall.findOne({ hostId: hostId })
      .sort({ createdAt: -1 })
      .limit(1);

    res.json({
      success: true,
      statistics: {
        totals: {
          all: totalCalls,
          answered: answeredCalls,
          accepted: acceptedCalls,
          anonymous: anonymousCalls,
          pending: await DoorbellCall.countDocuments({ hostId: hostId, status: 'pending' }),
          timeout: await DoorbellCall.countDocuments({ hostId: hostId, status: 'timeout' })
        },
        rates: {
          answerRate: totalCalls > 0 ? ((answeredCalls / totalCalls) * 100).toFixed(1) : 0,
          acceptanceRate: answeredCalls > 0 ? ((acceptedCalls / answeredCalls) * 100).toFixed(1) : 0
        },
        daily: dailyStats,
        lastCall: lastCall ? {
          id: lastCall._id,
          guestName: lastCall.guestName,
          status: lastCall.status,
          timeAgo: formatTimeAgo(lastCall.createdAt)
        } : null
      }
    });

  } catch (error) {
    console.error('Error getting statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estadísticas'
    });
  }
}

/**
 * Export call history to JSON
 * GET /notifications/export-history
 */
async function exportHistory(req, res) {
  try {
    const hostId = req.user._id;
    const { format = 'json' } = req.query;

    const calls = await DoorbellCall.find({ hostId: hostId })
      .sort({ createdAt: -1 })
      .lean();

    // Siempre exportar como JSON (sin CSV que podría ser pesado)
    res.json({
      success: true,
      exportDate: new Date().toISOString(),
      hostId: hostId,
      hostName: req.user.name,
      totalCalls: calls.length,
      calls: calls.map(call => ({
        ...call,
        // Añadir campos formateados
        createdAtFormatted: new Date(call.createdAt).toLocaleString('es-ES'),
        answeredAtFormatted: call.answeredAt ?
          new Date(call.answeredAt).toLocaleString('es-ES') : null
      }))
    });

  } catch (error) {
    console.error('Error exporting history:', error);
    res.status(500).json({
      success: false,
      error: 'Error exportando historial'
    });
  }
}

/**
 * Delete SINGLE call (solo para admin o host específico)
 * DELETE /notifications/delete-call/:callId
 */
async function deleteCall(req, res) {
  try {
    const { callId } = req.params;
    const hostId = req.user._id;

    console.log(`🗑️  Solicitando eliminación de llamada: ${callId}`);

    // Buscar la llamada
    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    // Verificar permisos
    if (doorbellCall.hostId.toString() !== hostId.toString()) {
      return res.status(403).json({ error: 'No tienes permisos para eliminar esta llamada' });
    }

    // SOLO permitir eliminar llamadas muy antiguas (más de 30 días)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (doorbellCall.createdAt > thirtyDaysAgo) {
      return res.status(400).json({
        error: 'Solo puedes eliminar llamadas con más de 30 días de antigüedad',
        minAgeRequired: '30 días',
        callAge: formatTimeAgo(doorbellCall.createdAt)
      });
    }

    // Eliminar (esto es OPCIONAL - normalmente no deberías eliminar)
    await DoorbellCall.findByIdAndDelete(callId);

    console.log(`✅ Llamada ${callId} eliminada del historial`);

    res.json({
      success: true,
      message: 'Llamada eliminada del historial',
      warning: 'Esta acción no se puede deshacer',
      callDeleted: {
        id: callId,
        guestName: doorbellCall.guestName,
        createdAt: doorbellCall.createdAt,
        status: doorbellCall.status
      }
    });

  } catch (error) {
    console.error('Error deleting call:', error);
    res.status(500).json({
      success: false,
      error: 'Error eliminando llamada'
    });
  }
}

// Función helper para formatear tiempo
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);

  let interval = Math.floor(seconds / 31536000);
  if (interval >= 1) return interval + (interval === 1 ? ' año' : ' años');

  interval = Math.floor(seconds / 2592000);
  if (interval >= 1) return interval + (interval === 1 ? ' mes' : ' meses');

  interval = Math.floor(seconds / 86400);
  if (interval >= 1) return interval + (interval === 1 ? ' día' : ' días');

  interval = Math.floor(seconds / 3600);
  if (interval >= 1) return interval + (interval === 1 ? ' hora' : ' horas');

  interval = Math.floor(seconds / 60);
  if (interval >= 1) return interval + (interval === 1 ? ' minuto' : ' minutos');

  return 'hace ' + Math.floor(seconds) + ' segundos';
}

module.exports = {
  registerPushToken,
  listPushTokens,
  callHost,
  getPendingCalls,
  respondCall,
  markOldTimeout,
  getCallHistory,
  getCallStatus,
  searchHistory,
  getStatistics,
  exportHistory,
  deleteCall
};