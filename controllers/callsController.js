
const CallSession = require('../models/CallSession');
const User = require('../models/User');
const { parsePositiveInt } = require('../utils/validation');
const { emitToUser, getCallRooms } = require('../websocket-server');
const { dispatchNotification } = require('../services/pushNotifications');

const ACTIVE_STATUSES = ['ringing', 'accepted'];
const CALL_RING_TIMEOUT_MS = 30 * 1000;
const CALL_INVITE_CATEGORY = 'call_invite';
const ringTimeoutTimers = new Map();
let ringingSweepStarted = false;

function toIdString(value) {
  if (!value) return null;
  return value.toString();
}

function createPairKey(a, b) {
  return [toIdString(a), toIdString(b)].filter(Boolean).sort().join(':');
}

function hasRelation(source, targetId) {
  const target = toIdString(targetId);
  return (source.guests || []).some((entry) => toIdString(entry?.guestId) === target) ||
    (source.hostRefs || []).some((entry) => toIdString(entry?.hostId) === target);
}

function buildParticipant(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email || null,
    role: user.role === 'admin' ? 'admin' : 'host',
  };
}

function buildPayload(session) {
  if (!session) return null;

  return {
    callId: session.callId,
    roomId: session.roomId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastEventAt: session.lastEventAt,
    answeredAt: session.answeredAt,
    endedAt: session.endedAt,
    endedBy: session.endedBy || null,
    reason: session.reason || null,
    caller: session.callerId?._id ? buildParticipant(session.callerId) : {
      id: session.callerId,
      name: session.callerName,
      email: null,
      role: 'host',
    },
    callee: session.calleeId?._id ? buildParticipant(session.calleeId) : {
      id: session.calleeId,
      name: session.calleeName,
      email: null,
      role: 'host',
    },
  };
}

async function loadSession(callId) {
  return CallSession.findOne({ callId })
    .populate('callerId', 'name email role')
    .populate('calleeId', 'name email role')
    .populate('endedBy', 'name email role');
}

function clearRingTimeout(callId) {
  const timer = ringTimeoutTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ringTimeoutTimers.delete(callId);
  }
}

async function expireRingingSession(callId) {
  const session = await loadSession(callId);
  if (!session || session.status !== 'ringing') {
    clearRingTimeout(callId);
    return null;
  }

  session.status = 'timeout';
  session.response = 'timeout';
  session.answeredAt = null;
  session.endedAt = new Date();
  session.endedBy = null;
  session.reason = 'no_answer';
  session.lastEventAt = new Date();
  await session.save();

  const populated = await loadSession(callId);
  removeRoom(callId);
  clearRingTimeout(callId);

  const payload = buildPayload(populated);
  const callerId = populated.callerId?._id || populated.callerId;
  const calleeId = populated.calleeId?._id || populated.calleeId;

  emitToUser(callerId, 'call:timeout', payload);
  emitToUser(calleeId, 'call:ended', payload);

  await dispatchNotification({
    userId: callerId,
    socketEvent: 'call:timeout',
    title: 'Llamada perdida',
    body: `${payload.callee?.name || 'Tu contacto'} no respondió a tiempo`,
    payload: {
      ...payload,
      type: 'call_missed',
      callKind: 'session',
      screen: '/calls/[callId]',
      params: {
        callId: payload.callId,
        role: 'caller',
      },
    },
    data: {
      type: 'call_missed',
      callKind: 'session',
      callId: payload.callId,
      roomId: payload.roomId,
      callerId: toIdString(callerId),
      calleeId: toIdString(calleeId),
      screen: '/calls/[callId]',
      params: {
        callId: payload.callId,
        role: 'caller',
      },
    },
  });

  return payload;
}

function scheduleRingTimeout(callId) {
  clearRingTimeout(callId);

  const timer = setTimeout(() => {
    expireRingingSession(callId).catch((error) => {
      console.error('[calls:timeout] error expirando llamada:', error);
    });
  }, CALL_RING_TIMEOUT_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  ringTimeoutTimers.set(callId, timer);
}

async function sweepExpiredRingingSessions() {
  const cutoff = new Date(Date.now() - CALL_RING_TIMEOUT_MS);
  const overdueSessions = await CallSession.find({
    status: 'ringing',
    createdAt: { $lte: cutoff },
  }).select('callId');

  for (const session of overdueSessions) {
    await expireRingingSession(session.callId);
  }
}

function startRingingSweep() {
  if (ringingSweepStarted) return;
  ringingSweepStarted = true;

  const interval = setInterval(() => {
    sweepExpiredRingingSessions().catch((error) => {
      console.error('[calls:timeout] error en sweep:', error);
    });
  }, 5000);

  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

function upsertRoom(session, extra = {}) {
  const callRooms = getCallRooms();
  if (!callRooms) return;

  const current = callRooms.get(session.callId) || {};
  callRooms.set(session.callId, {
    ...current,
    callId: session.callId,
    roomId: session.roomId,
    callerId: toIdString(session.callerId?._id || session.callerId),
    calleeId: toIdString(session.calleeId?._id || session.calleeId),
    status: session.status,
    lastEventAt: new Date(),
    ...extra,
  });
}

function removeRoom(callId) {
  const callRooms = getCallRooms();
  if (!callRooms) return;
  callRooms.delete(callId);
}

function buildDisplayStatus(session, viewerId) {
  if (session.status === 'ringing') {
    return 'En curso';
  }

  if (session.status === 'accepted' && !session.endedAt) {
    return 'En curso';
  }

  if (session.status === 'rejected') {
    return 'Rechazada';
  }

  if (session.status === 'cancelled') {
    return toIdString(session.endedBy) === viewerId ? 'Cancelada' : 'Perdida';
  }

  if (session.status === 'timeout') {
    return 'Perdida';
  }

  if (session.status === 'ended') {
    if (!session.answeredAt) {
      return toIdString(session.endedBy) === viewerId ? 'Cancelada' : 'Perdida';
    }

    return 'Respondida';
  }

  return session.status;
}

function buildDurationSeconds(session) {
  if (!session.answeredAt) return 0;
  const endAt = session.endedAt || new Date();
  const diff = Math.max(0, new Date(endAt).getTime() - new Date(session.answeredAt).getTime());
  return Math.floor(diff / 1000);
}

function formatDuration(seconds) {
  const total = Math.max(0, seconds || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function buildHistoryItem(session, viewerId) {
  const callerId = toIdString(session.callerId?._id || session.callerId);
  const calleeId = toIdString(session.calleeId?._id || session.calleeId);
  const direction = viewerId && viewerId === callerId ? 'outgoing' : 'incoming';
  const durationSeconds = buildDurationSeconds(session);
  const displayStatus = buildDisplayStatus(session, viewerId);

  return {
    id: session._id,
    callId: session.callId,
    roomId: session.roomId,
    direction,
    status: session.status,
    displayStatus,
    answered: !!session.answeredAt,
    durationSeconds,
    durationLabel: session.answeredAt ? formatDuration(durationSeconds) : '00:00',
    createdAt: session.createdAt,
    answeredAt: session.answeredAt || null,
    endedAt: session.endedAt || null,
    endedBy: session.endedBy?._id || session.endedBy || null,
    endedByName: session.endedBy?.name || null,
    caller: {
      id: callerId,
      name: session.callerId?.name || session.callerName || 'Contacto',
      email: session.callerId?.email || null,
    },
    callee: {
      id: calleeId,
      name: session.calleeId?.name || session.calleeName || 'Contacto',
      email: session.calleeId?.email || null,
    },
    reason: session.reason || null,
  };
}

async function createCallSession(req, res) {
  try {
    const { contactUserId } = req.body;
    console.log('[calls:sessions:create] request:', {
      callerId: req.user?._id?.toString?.(),
      contactUserId: contactUserId || null,
    });
    if (!contactUserId) {
      return res.status(400).json({ error: 'contactUserId requerido' });
    }

    const caller = req.user;
    const callee = await User.findById(contactUserId);

    if (!callee) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    if (caller._id.toString() === callee._id.toString()) {
      return res.status(400).json({ error: 'No puedes llamarte a ti mismo' });
    }

    if (!hasRelation(caller, callee._id) && !hasRelation(callee, caller._id)) {
      return res.status(403).json({ error: 'Solo puedes llamar a contactos vinculados' });
    }

    const pairKey = createPairKey(caller._id, callee._id);
    const existingSession = await CallSession.findOne({
      pairKey,
      status: { $in: ACTIVE_STATUSES },
    })
      .sort({ updatedAt: -1 })
      .populate('callerId', 'name email role')
      .populate('calleeId', 'name email role')
      .populate('endedBy', 'name email role');

    if (existingSession) {
      upsertRoom(existingSession);
      const payload = buildPayload(existingSession);
      const calleeId = existingSession.calleeId?._id || existingSession.calleeId;
      const callerId = existingSession.callerId?._id || existingSession.callerId;

      if (existingSession.status === 'ringing') {
        emitToUser(callerId, 'call:state', payload);
      }

      return res.json({
        call: payload,
        reused: true,
      });
    }

    const session = await CallSession.create({
      pairKey,
      callerId: caller._id,
      calleeId: callee._id,
      callerName: caller.name,
      calleeName: callee.name,
      status: 'ringing',
    });

    const populated = await loadSession(session.callId);
    upsertRoom(populated);

    const payload = buildPayload(populated);
    console.log('[calls:sessions:create] created:', {
      callId: payload.callId,
      callerId: toIdString(payload.caller?.id),
      calleeId: toIdString(payload.callee?.id),
      status: payload.status,
    });
    emitToUser(caller._id, 'call:state', payload);

    scheduleRingTimeout(payload.callId);

    await dispatchNotification({
      userId: callee._id,
      socketEvent: 'call:invite',
      title: 'Llamada entrante',
      body: `${caller.name} te está llamando`,
      categoryId: CALL_INVITE_CATEGORY,
      payload: {
        ...payload,
        type: 'call_invite',
        callKind: 'session',
        screen: '/calls/[callId]',
        params: {
          callId: payload.callId,
          role: 'callee',
        },
      },
      data: {
        type: 'call_invite',
        callKind: 'session',
        callId: payload.callId,
        roomId: payload.roomId,
        callerId: caller._id.toString(),
        callerName: caller.name,
        calleeId: callee._id.toString(),
        calleeName: callee.name,
        screen: '/calls/[callId]',
        params: {
          callId: payload.callId,
          role: 'callee',
        },
      },
    });

    return res.status(201).json({
      call: payload,
      reused: false,
    });
  } catch (error) {
    console.error('[calls:sessions:create] error:', error);
    return res.status(500).json({ error: 'No se pudo crear la llamada' });
  }
}

async function getCallSession(req, res) {
  try {
    console.log('[calls:sessions:get] request:', {
      callId: req.params.callId,
      userId: req.user?._id?.toString?.(),
    });
    const session = await loadSession(req.params.callId);
    if (!session) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    const userId = req.user._id.toString();
    const callerId = toIdString(session.callerId?._id || session.callerId);
    const calleeId = toIdString(session.calleeId?._id || session.calleeId);

    if (userId !== callerId && userId !== calleeId) {
      return res.status(403).json({ error: 'No autorizado para ver esta llamada' });
    }

    return res.json({
      call: buildPayload(session),
    });
  } catch (error) {
    console.error('[calls:sessions:get] error:', error);
    return res.status(500).json({ error: 'No se pudo cargar la llamada' });
  }
}

async function acceptCallSession(req, res) {
  try {
    console.log('[calls:sessions:accept] request:', {
      callId: req.params.callId,
      userId: req.user?._id?.toString?.(),
    });
    const session = await loadSession(req.params.callId);
    if (!session) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    if (toIdString(session.calleeId?._id || session.calleeId) !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Solo el receptor puede aceptar' });
    }

    if (session.status !== 'ringing') {
      return res.status(409).json({ error: 'La llamada ya no está pendiente' });
    }

    session.status = 'accepted';
    session.answeredAt = new Date();
    session.lastEventAt = new Date();
    await session.save();

    const populated = await loadSession(session.callId);
    upsertRoom(populated);
    const payload = buildPayload(populated);
    console.log('[calls:sessions:accept] accepted:', {
      callId: payload.callId,
      status: payload.status,
    });

    clearRingTimeout(session.callId);
    emitToUser(populated.callerId?._id || populated.callerId, 'call:accepted', payload);
    emitToUser(populated.calleeId?._id || populated.calleeId, 'call:state', payload);

    return res.json({ call: payload });
  } catch (error) {
    console.error('[calls:sessions:accept] error:', error);
    return res.status(500).json({ error: 'No se pudo aceptar la llamada' });
  }
}

async function rejectCallSession(req, res) {
  try {
    console.log('[calls:sessions:reject] request:', {
      callId: req.params.callId,
      userId: req.user?._id?.toString?.(),
    });
    const session = await loadSession(req.params.callId);
    if (!session) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    if (toIdString(session.calleeId?._id || session.calleeId) !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Solo el receptor puede rechazar' });
    }

    if (!ACTIVE_STATUSES.includes(session.status)) {
      return res.status(409).json({ error: 'La llamada ya no está activa' });
    }

    session.status = 'rejected';
    session.endedAt = new Date();
    session.endedBy = req.user._id;
    session.lastEventAt = new Date();
    await session.save();

    const populated = await loadSession(session.callId);
    removeRoom(session.callId);
    clearRingTimeout(session.callId);
    const payload = buildPayload(populated);
    console.log('[calls:sessions:reject] rejected:', {
      callId: payload.callId,
      status: payload.status,
    });

    emitToUser(populated.callerId?._id || populated.callerId, 'call:rejected', payload);
    emitToUser(populated.calleeId?._id || populated.calleeId, 'call:state', payload);

    return res.json({ call: payload });
  } catch (error) {
    console.error('[calls:sessions:reject] error:', error);
    return res.status(500).json({ error: 'No se pudo rechazar la llamada' });
  }
}

async function endCallSession(req, res) {
  try {
    console.log('[calls:sessions:end] request:', {
      callId: req.params.callId,
      userId: req.user?._id?.toString?.(),
    });
    const session = await loadSession(req.params.callId);
    if (!session) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    const userId = req.user._id.toString();
    const callerId = toIdString(session.callerId?._id || session.callerId);
    const calleeId = toIdString(session.calleeId?._id || session.calleeId);

    if (userId !== callerId && userId !== calleeId) {
      return res.status(403).json({ error: 'No autorizado para finalizar esta llamada' });
    }

    if (ACTIVE_STATUSES.includes(session.status) || session.status === 'accepted') {
      session.status = session.status === 'ringing' && !session.answeredAt ? 'cancelled' : 'ended';
      session.endedAt = new Date();
      session.endedBy = req.user._id;
      session.lastEventAt = new Date();
      await session.save();
    }

    const populated = await loadSession(session.callId);
    removeRoom(session.callId);
    clearRingTimeout(session.callId);
    const payload = buildPayload(populated);
    console.log('[calls:sessions:end] ended:', {
      callId: payload.callId,
      status: payload.status,
      endedBy: req.user?._id?.toString?.(),
    });

    emitToUser(callerId, 'call:ended', payload);
    emitToUser(calleeId, 'call:ended', payload);

    return res.json({ call: payload });
  } catch (error) {
    console.error('[calls:sessions:end] error:', error);
    return res.status(500).json({ error: 'No se pudo finalizar la llamada' });
  }
}

async function getCallHistory(req, res) {
  try {
    const isAdmin = req.user.role === 'admin';
    const targetUserId = isAdmin && req.query.userId ? String(req.query.userId) : req.user._id.toString();
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : 'all';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : null;
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 10000 });
    const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });

    const filter = {
      $or: [{ callerId: targetUserId }, { calleeId: targetUserId }],
    };

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const [total, sessions] = await Promise.all([
      CallSession.countDocuments(filter),
      CallSession.find(filter)
        .populate('callerId', 'name email role')
        .populate('calleeId', 'name email role')
        .populate('endedBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    const calls = sessions.map((session) => buildHistoryItem(session, targetUserId));

    const stats = calls.reduce(
      (acc, item) => {
        acc.total += 1;
        if (item.answered) acc.answered += 1;
        if (item.displayStatus === 'Perdida') acc.missed += 1;
        if (item.displayStatus === 'Rechazada') acc.rejected += 1;
        if (item.displayStatus === 'Cancelada') acc.cancelled += 1;
        acc.totalDurationSeconds += item.durationSeconds;
        return acc;
      },
      {
        total: 0,
        answered: 0,
        missed: 0,
        rejected: 0,
        cancelled: 0,
        totalDurationSeconds: 0,
      },
    );

    return res.json({
      success: true,
      calls,
      pagination: {
        totalPages: Math.ceil(total / limit),
        currentPage: page,
        totalCalls: total,
        limit,
      },
      summary: {
        total: stats.total,
        answered: stats.answered,
        missed: stats.missed,
        rejected: stats.rejected,
        cancelled: stats.cancelled,
        averageDurationSeconds: stats.answered > 0 ? Math.round(stats.totalDurationSeconds / stats.answered) : 0,
      },
    });
  } catch (error) {
    console.error('[calls:history] error:', error);
    return res.status(500).json({ success: false, error: 'Error obteniendo historial de llamadas' });
  }
}

startRingingSweep();

module.exports = {
  createCallSession,
  getCallSession,
  acceptCallSession,
  rejectCallSession,
  endCallSession,
  getCallHistory,
};
