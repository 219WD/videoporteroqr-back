const socketIo = require('socket.io');
const { ALLOWED_ORIGINS } = require('../config/env');
const { createConnectionHandlers } = require('./handlers');
const { createWebSocketStats } = require('./stats');
const { createScopedLogger } = require('../utils/logger');

let io;
let stats = createWebSocketStats();
const log = createScopedLogger('websocket');

function initializeWebSocket(server) {
  io = socketIo(server, {
    cors: {
      methods: ['GET', 'POST'],
      origin: ALLOWED_ORIGINS,
    },
  });

  io.on('connection', (socket) => {
    stats.trackConnect();
    log.info('connect', { socketId: socket.id });
    createConnectionHandlers(socket, {
      io,
      onDisconnect: () => {
        stats.trackDisconnect();
        log.info('disconnect', { socketId: socket.id });
      },
    });
  });

  return io;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.io no inicializado');
  }

  return io;
}

function getWebSocketStats() {
  return stats.snapshot({
    activeConnections: io?.sockets?.sockets?.size || 0,
  });
}

module.exports = {
  getIO,
  getWebSocketStats,
  initializeWebSocket,
};
