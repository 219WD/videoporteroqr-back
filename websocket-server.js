const jwt = require('jsonwebtoken');
const socketIo = require('socket.io');
const User = require('./models/User');
const { ALLOWED_ORIGINS, JWT_SECRET } = require('./config/env');
const { verifyGuestToken } = require('./utils/accessTokens');
const { createSocketState } = require('./websocket/socketState');
const { createSocketHelpers } = require('./websocket/socketUtils');

let io;
let socketState = null;
let socketHelpers = null;
let hostRoomsInstance = null;
let roomsInstance = null;
let userSocketMapInstance = null;
let callRoomsInstance = null;
let getServerStatsInstance = null;

function normalizeSocketToken(token) {
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

async function resolveSocketAuth(token) {
  const normalized = normalizeSocketToken(token);
  if (!normalized) {
    return null;
  }

  const guestPayload = verifyGuestToken(normalized);
  if (guestPayload) {
    return {
      kind: 'guest',
      guest: guestPayload,
    };
  }

  try {
    const payload = jwt.verify(normalized, JWT_SECRET);
    const user = await User.findById(payload.id).select('_id role name');

    if (!user) {
      return null;
    }

    return {
      kind: 'user',
      user: {
        id: user._id.toString(),
        role: user.role,
        name: user.name,
      },
    };
  } catch (error) {
    return null;
  }
}

function verifySocketGuestAccess(data, callId) {
  const token = data?.token || data?.guestToken || data?.accessToken || null;
  const payload = verifyGuestToken(token);

  if (!payload || !callId) {
    return null;
  }

  if (payload.callId?.toString?.() !== callId.toString()) {
    return null;
  }

  return payload;
}

function initializeWebSocket(server) {
  io = socketIo(server, {
    cors: {
      methods: ['GET', 'POST'],
      origin: ALLOWED_ORIGINS,
    },
  });

  socketState = createSocketState();
  socketHelpers = createSocketHelpers(io, socketState);

  const { callRooms, flowRooms, hostRooms, rooms, userSocketMap } = socketState;

  roomsInstance = rooms;
  userSocketMapInstance = userSocketMap;
  hostRoomsInstance = hostRooms;
  callRoomsInstance = callRooms;

  io.use(async (socket, next) => {
    try {
      socket.data.auth = await resolveSocketAuth(socket.handshake.auth?.token);
      next();
    } catch (error) {
      next(error);
    }
  });

  io.on('connection', (socket) => {
    console.log('Socket conectado:', socket.id);

    socket.on('host-join', (data = {}) => {
      const { hostId } = data;
      if (!hostId) return;

      socket.join(`host-${hostId}`);
      hostRooms.set(hostId.toString(), socket.id);
    });

    socket.on('host-join-flows', (data = {}) => {
      const { hostId } = data;
      if (!hostId) return;

      socket.join(`host-${hostId}`);
      hostRooms.set(hostId.toString(), socket.id);
    });

    socket.on('request-message-details', (data = {}) => {
      const { callId, hostId } = data;
      if (!callId || !hostId) return;

      const flow = flowRooms.get(callId);
      if (!flow || flow.actionType !== 'message') return;

      io.to(`host-${hostId}`).emit('flow-message-details', {
        type: 'message_details',
        callId,
        guestName: flow.guestName || 'Visitante',
        fullMessage: flow.message,
        urgency: 'medium',
        requiresResponse: true,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('flow-response', (data = {}) => {
      const { callId, response, hostMessage } = data;
      if (!callId || !response || !flowRooms.has(callId)) return;

      const flow = flowRooms.get(callId);
      flow.status = response === 'accept' ? 'answered' : 'rejected';
      flow.response = response;
      flow.answeredAt = new Date();

      io.to(`flow-${callId}`).emit('flow-response', {
        callId,
        response,
        hostMessage,
        timestamp: new Date().toISOString(),
      });

      io.to(`user-${flow.hostId}`).emit('flow-response', {
        callId,
        response,
        hostMessage,
        timestamp: new Date().toISOString(),
      });

      if (hostMessage) {
        const messagePayload = {
          callId,
          sender: 'host',
          message: hostMessage,
          timestamp: new Date().toISOString(),
          guestName: flow.guestName,
        };

        io.to(`flow-${callId}`).emit('new-flow-message', messagePayload);
        io.to(`user-${flow.hostId}`).emit('new-flow-message', messagePayload);
        io.to(`user-${flow.hostId}`).emit('anonymous-conversation-updated', {
          callId,
          guestName: flow.guestName,
          actionType: flow.actionType,
          status: flow.status,
          response: flow.response,
          lastMessageAt: messagePayload.timestamp,
          lastMessageText: hostMessage,
          lastMessageSender: 'host',
          hostUnreadCount: 0,
        });
      }
    });

    socket.on('user-connected', (data = {}) => {
      const { userId } = data;
      if (!userId) return;

      socket.join(`user-${userId}`);
      userSocketMap.set(userId.toString(), socket.id);
    });

    socket.on('join-flow-room', (data = {}) => {
      const { callId } = data;
      if (!callId) {
        console.warn('Intento de unirse a flow sin callId');
        return;
      }

      const auth = socket.data.auth || null;
      const guestCallId = auth?.kind === 'guest' ? auth.guest?.callId?.toString?.() : null;
      const fallbackGuestAccess = verifySocketGuestAccess(data, callId);
      if (guestCallId !== callId?.toString?.() && !fallbackGuestAccess) {
        console.warn('Guest sin token válido intentando unirse a flow-room', { callId });
        return;
      }

      socket.join(`flow-${callId}`);
      socket.emit('flow-joined', {
        callId,
        message: 'Conectado al flujo. Esperando respuesta del anfitrión...',
      });
    });

    socket.on('disconnect', () => {
      for (const [hostId, socketId] of hostRooms.entries()) {
        if (socketId === socket.id) {
          hostRooms.delete(hostId);
          break;
        }
      }

      for (const [flowId, flow] of flowRooms.entries()) {
        if (flow.hostSocket === socket.id) {
          flowRooms.delete(flowId);
        }
      }

      for (const [userId, socketId] of userSocketMap.entries()) {
        if (socketId === socket.id) {
          userSocketMap.delete(userId);
          break;
        }
      }
    });

    socket.on('error', (error) => {
      console.error('Error en socket:', error);
    });

    socket.on('ping', () => {
      socket.emit('pong', {
        message: 'Servidor funcionando correctamente',
        timestamp: new Date().toISOString(),
      });
    });

    socket.emit('connection-established', {
      socketId: socket.id,
      message: 'Conectado al servidor de notificaciones',
      timestamp: new Date().toISOString(),
    });
  });

  function notifyHost(hostId, event, data) {
    return socketHelpers.notifyHost(hostId, event, data);
  }

  function notifyUser(userId, event, data) {
    return socketHelpers.notifyUser(userId, event, data);
  }

  function isHostOnline(hostId) {
    return socketHelpers.isHostOnline(hostId);
  }

  function getServerStats() {
    return socketHelpers.getServerStats();
  }

  function getFlowRooms() {
    return flowRooms;
  }

  io.notifyHost = notifyHost;
  io.notifyUser = notifyUser;
  io.isHostOnline = isHostOnline;
  io.getServerStats = getServerStats;
  io.getFlowRooms = getFlowRooms;

  getServerStatsInstance = getServerStats;

  console.log('Servidor WebSocket inicializado correctamente');

  return io;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.io no inicializado');
  }
  return io;
}

function getHostRooms() {
  return hostRoomsInstance;
}

function getCallRooms() {
  return callRoomsInstance;
}

function getRooms() {
  return roomsInstance;
}

function getUserSocketMap() {
  return userSocketMapInstance;
}

function getServerStats() {
  if (typeof getServerStatsInstance !== 'function') {
    return {
      callRooms: 0,
      flowRooms: 0,
      hostRooms: 0,
      trackedCalls: 0,
      totalConnections: 0,
      userConnections: 0,
    };
  }

  return getServerStatsInstance();
}

module.exports = {
  initializeWebSocket,
  getIO,
  getHostRooms,
  getCallRooms,
  getRooms,
  getUserSocketMap,
  getServerStats,
};
