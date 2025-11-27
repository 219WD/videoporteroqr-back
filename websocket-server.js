// websocket-server.js - VERSIÓN COMPLETA CON NOTIFICACIONES EN TIEMPO REAL
const socketIo = require('socket.io');

let io;

function initializeWebSocket(server) {
  io = socketIo(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const rooms = new Map();
  const userSocketMap = new Map();
  const hostRooms = new Map(); // Mapa para hosts y sus salas de notificación

  io.on('connection', (socket) => {
    console.log('🔌 Usuario conectado:', socket.id);

    // ✅ HOST: Unirse para recibir notificaciones de llamadas
    socket.on('host-join', (data) => {
      const { hostId } = data;
      console.log('🏠 Host unido a notificaciones:', hostId);

      // Unir el socket a la sala del host
      socket.join(`host-${hostId}`);
      hostRooms.set(hostId.toString(), socket.id);

      console.log(`✅ Host ${hostId} listo para recibir notificaciones`);
    });

    // ✅ GUEST: Llamar al host - NOTIFICACIÓN EN TIEMPO REAL
    socket.on('call-host', (data) => {
      const { hostId, call } = data;
      console.log('🔔📞 CALL-HOST recibido - Host ID:', hostId, 'Call ID:', call._id);
      console.log('🔔 Detalles call:', call);

      // Verificar si el host está en línea
      const hostSocketId = hostRooms.get(hostId.toString());
      console.log('🔔 Host socket ID encontrado:', hostSocketId);
      console.log('🔔 Host rooms actuales:', Array.from(hostRooms.entries()));

      if (hostSocketId) {
        // Emitir a todos los sockets del host
        io.to(`host-${hostId}`).emit('call-incoming', call);
        console.log(`📢 Notificación enviada a host-${hostId}`);

        // Verificar si se envió correctamente
        const hostSockets = io.sockets.adapter.rooms.get(`host-${hostId}`);
        console.log(`🔔 Sockets en sala host-${hostId}:`, hostSockets ? Array.from(hostSockets) : 'NINGUNO');
      } else {
        console.log(`❌ Host ${hostId} no encontrado en hostRooms`);
        console.log('🔔 Host rooms disponibles:', Array.from(hostRooms.entries()));
      }
    });

    // ✅ HOST: Responder a la llamada
    socket.on('call-response', (data) => {
      const { callId, response } = data;
      console.log('📞 Respuesta del host:', callId, response);

      // Emitir respuesta a todos (el guest estará escuchando)
      io.emit('call-response', {
        callId,
        response
      });
      console.log(`📢 Respuesta del host enviada para call ${callId}: ${response}`);
    });

    // ✅ USUARIO: Conectarse para videollamadas generales
    socket.on('user-connected', (data) => {
      const { userId, userType } = data;
      console.log(`👤 Usuario ${userId} (${userType}) conectado`);

      socket.join(`user-${userId}`);
      userSocketMap.set(userId.toString(), socket.id);
    });

    // ✅ SALA SIMPLE: Para la página web
    socket.on('join-room', (data) => {
      const { roomId, role } = data;
      console.log(`🎯 ${role} uniéndose a sala: ${roomId}`);

      socket.join(roomId);
      socket.to(roomId).emit('user-joined', { role });
    });

    // ✅ WEBRTC: Oferta del guest
    socket.on('call-offer', async (data) => {
      const { offer, roomId, hostId, guestId } = data;
      console.log(`📨 Offer WebRTC recibido en sala ${roomId}`, offer.type);

      // Reenviar la oferta al host específico
      if (hostId) {
        io.to(`user-${hostId}`).emit('call-offer', {
          offer,
          from: socket.id,
          guestId
        });
      } else {
        // O reenviar a toda la sala
        socket.to(roomId).emit('call-offer', {
          offer,
          from: socket.id
        });
      }
    });

    // ✅ WEBRTC: Answer del host
    socket.on('answer', (data) => {
      const { answer, roomId, targetUserId } = data;
      console.log(`📨 Answer WebRTC para sala ${roomId}`, answer.type);

      if (targetUserId) {
        // Enviar a usuario específico
        io.to(`user-${targetUserId}`).emit('answer', { answer });
      } else {
        // Reenviar el answer a la sala
        socket.to(roomId).emit('answer', { answer });
      }
    });

    // ✅ WEBRTC: ICE candidates
    socket.on('ice-candidate', (data) => {
      const { candidate, to, targetUserId } = data;
      console.log(`🧊 ICE candidate enviado`);

      if (targetUserId) {
        // Enviar a usuario específico
        io.to(`user-${targetUserId}`).emit('ice-candidate', { candidate });
      } else if (to) {
        // Enviar a sala específica
        socket.to(to).emit('ice-candidate', { candidate });
      }
    });

    // ✅ WEBRTC: Llamada aceptada
    socket.on('call-accepted', (data) => {
      const { roomId } = data;
      console.log(`✅ Llamada aceptada en sala: ${roomId}`);

      socket.to(roomId).emit('call-accepted');
    });

    // ✅ WEBRTC: Llamada rechazada
    socket.on('call-rejected', (data) => {
      const { roomId } = data;
      console.log(`❌ Llamada rechazada en sala: ${roomId}`);

      socket.to(roomId).emit('call-rejected');
    });

    // ✅ SALA DE VIDEOCALL: Unirse a sala específica
    socket.on('join-call-room', async (data) => {
      const { callId, userId, userRole } = data;

      console.log(`🎥 Usuario ${userId || 'anonimo'} (${userRole}) uniéndose a sala ${callId}`);

      // ✅ CORREGIDO: Verificar que userId exista
      if (userId) {
        userSocketMap.set(userId.toString(), socket.id);
      } else {
        console.log(`⚠️ Usuario anónimo uniéndose a sala ${callId}`);
      }

      // Unirse a la sala
      socket.join(callId);

      // Guardar información de la sala
      if (!rooms.has(callId)) {
        rooms.set(callId, {
          host: null,
          guest: null,
          hostCameraEnabled: false,
          guestCameraEnabled: true,
          audioEnabled: true
        });
      }

      const room = rooms.get(callId);

      if (userRole === 'host') {
        room.host = userId.toString();
        socket.to(callId).emit('host-ready');
      } else if (userRole === 'guest') {
        room.guest = userId.toString();
        socket.to(callId).emit('user-joined', {
          userId,
          userRole,
          cameraEnabled: room.guestCameraEnabled
        });
      }

      // Enviar configuración actual de la sala al usuario
      socket.emit('room-config', {
        callId,
        userRole,
        cameraEnabled: userRole === 'guest' ? room.guestCameraEnabled : room.hostCameraEnabled,
        audioEnabled: room.audioEnabled
      });

      // Si ambos usuarios están en la sala, notificar conexión establecida
      if (room.host && room.guest) {
        io.to(callId).emit('call-connected', { callId });
      }
    });

    // ✅ SEÑALES WEBRTC GENÉRICAS
    socket.on('webrtc-signal', (data) => {
      const { callId, signal } = data;
      console.log(`📡 Señal WebRTC enviada en sala ${callId}`);

      socket.to(callId).emit('webrtc-signal', {
        signal,
        fromUser: socket.id
      });
    });

    // ✅ TOGGLE CÁMARA DEL HOST
    socket.on('toggle-host-camera', (data) => {
      const { callId, enabled } = data;
      const room = rooms.get(callId);

      if (room) {
        room.hostCameraEnabled = enabled;
        console.log(`📷 Cámara del host ${enabled ? 'activada' : 'desactivada'} en sala ${callId}`);

        socket.to(callId).emit('host-camera-toggled', { enabled });
      }
    });

    // ✅ TOGGLE AUDIO
    socket.on('toggle-audio', (data) => {
      const { callId, enabled } = data;
      const room = rooms.get(callId);

      if (room) {
        room.audioEnabled = enabled;
        console.log(`🎤 Audio ${enabled ? 'activado' : 'desactivado'} en sala ${callId}`);

        io.to(callId).emit('audio-toggled', {
          enabled,
          userId: socket.id,
          userRole: room.host === socket.id ? 'host' : 'guest'
        });
      }
    });

    // ✅ FINALIZAR LLAMADA
    socket.on('end-call', (data) => {
      const { callId, roomId } = data;
      const targetRoom = callId || roomId;

      console.log(`📞 Llamada finalizada en sala ${targetRoom}`);

      io.to(targetRoom).emit('call-ended');

      if (rooms.has(targetRoom)) {
        rooms.delete(targetRoom);
      }
    });

    // ✅ MENSAJES EN TIEMPO REAL
    socket.on('send-message', (data) => {
      const { callId, message, sender } = data;
      console.log(`💬 Mensaje enviado en call ${callId} por ${sender}`);

      socket.to(callId).emit('new-message', {
        message,
        sender,
        timestamp: new Date().toISOString()
      });
    });

    // ✅ VERIFICAR CONEXIÓN DE HOST
    socket.on('check-host-online', (data) => {
      const { hostId } = data;
      const isOnline = hostRooms.has(hostId.toString());

      socket.emit('host-online-status', {
        hostId,
        isOnline
      });

      console.log(`🔍 Verificación de host ${hostId}: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
    });

    // ✅ MANEJAR DESCONEXIÓN
    socket.on('disconnect', (reason) => {
      console.log('🔌 Usuario desconectado:', socket.id, 'Razón:', reason);

      // Limpiar host rooms
      for (const [hostId, socketId] of hostRooms.entries()) {
        if (socketId === socket.id) {
          hostRooms.delete(hostId);
          console.log(`🏠 Host ${hostId} desconectado`);
          break;
        }
      }

      // Limpiar salas de videollamada
      for (const [callId, room] of rooms.entries()) {
        const userRole = room.host === socket.id ? 'host' :
          room.guest === socket.id ? 'guest' : null;

        if (userRole) {
          socket.to(callId).emit('user-left', {
            userId: socket.id,
            userRole
          });

          if (userRole === 'host') room.host = null;
          else if (userRole === 'guest') room.guest = null;

          if (!room.host && !room.guest) {
            rooms.delete(callId);
          }
        }
      }

      // Limpiar mapa de usuarios
      for (const [userId, socketId] of userSocketMap.entries()) {
        if (socketId === socket.id) {
          userSocketMap.delete(userId);
          break;
        }
      }
    });

    // ✅ MANEJAR ERRORES
    socket.on('error', (error) => {
      console.error('❌ Error en socket:', error);
    });

    // ✅ EVENTO DE PRUEBA/PING
    socket.on('ping', (data) => {
      socket.emit('pong', {
        message: 'Servidor funcionando correctamente',
        timestamp: new Date().toISOString()
      });
    });

    // ✅ ENVIAR ESTADO INICIAL AL CLIENTE
    socket.emit('connection-established', {
      socketId: socket.id,
      message: 'Conectado al servidor de notificaciones',
      timestamp: new Date().toISOString()
    });

  });

  // ✅ FUNCIONES DE UTILIDAD PARA EL RESTO DE LA APLICACIÓN

  // Notificar a un host específico
  function notifyHost(hostId, event, data) {
    const hostSocketId = hostRooms.get(hostId.toString());
    if (hostSocketId) {
      io.to(hostSocketId).emit(event, data);
      return true;
    }
    return false;
  }

  // Notificar a un usuario específico
  function notifyUser(userId, event, data) {
    const userSocketId = userSocketMap.get(userId.toString());
    if (userSocketId) {
      io.to(userSocketId).emit(event, data);
      return true;
    }
    return false;
  }

  // Verificar si un host está en línea
  function isHostOnline(hostId) {
    return hostRooms.has(hostId.toString());
  }

  // Obtener estadísticas del servidor
  function getServerStats() {
    return {
      totalConnections: io.engine.clientsCount,
      hostRooms: hostRooms.size,
      callRooms: rooms.size,
      userConnections: userSocketMap.size
    };
  }

  // ✅ EXPORTAR FUNCIONES DE UTILIDAD
  io.notifyHost = notifyHost;
  io.notifyUser = notifyUser;
  io.isHostOnline = isHostOnline;
  io.getServerStats = getServerStats;

  console.log('🚀 Servidor WebSocket inicializado correctamente');

  // ✅ LOG PERIÓDICO DE ESTADÍSTICAS
  setInterval(() => {
    const stats = getServerStats();
    console.log('📊 Estadísticas del servidor:', stats);
  }, 60000); // Cada minuto

  return io;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.io no inicializado');
  }
  return io;
}

module.exports = {
  initializeWebSocket,
  getIO
};