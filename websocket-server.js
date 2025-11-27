// websocket-server.js - MEJORADO CON WEBRTC COMPLETO
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

  io.on('connection', (socket) => {
    console.log('🔌 Usuario conectado:', socket.id);

    // ✅ NUEVO: Unirse a sala simple (para la página web)
    socket.on('join-room', (data) => {
      const { roomId, role } = data;
      console.log(`🎯 ${role} uniéndose a sala: ${roomId}`);
      
      socket.join(roomId);
      socket.to(roomId).emit('user-joined', { role });
    });

    // ✅ NUEVO: Manejar oferta WebRTC del guest
    socket.on('call-offer', async (data) => {
      const { offer, roomId } = data;
      console.log(`📨 Offer WebRTC recibido en sala ${roomId}`, offer.type);
      
      // Reenviar la oferta al host
      socket.to(roomId).emit('call-offer', { 
        offer,
        from: socket.id 
      });
    });

    // ✅ NUEVO: Manejar answer del host
    socket.on('answer', (data) => {
      const { answer, roomId } = data;
      console.log(`📨 Answer WebRTC para sala ${roomId}`, answer.type);
      
      // Reenviar el answer al guest
      socket.to(roomId).emit('answer', { answer });
    });

    // ✅ NUEVO: Manejar ICE candidates
    socket.on('ice-candidate', (data) => {
      const { candidate, to } = data;
      console.log(`🧊 ICE candidate enviado a: ${to}`);
      
      socket.to(to).emit('ice-candidate', { candidate });
    });

    // ✅ NUEVO: Llamada aceptada por el host
    socket.on('call-accepted', (data) => {
      const { roomId } = data;
      console.log(`✅ Llamada aceptada en sala: ${roomId}`);
      
      socket.to(roomId).emit('call-accepted');
    });

    // ✅ NUEVO: Llamada rechazada por el host
    socket.on('call-rejected', (data) => {
      const { roomId } = data;
      console.log(`❌ Llamada rechazada en sala: ${roomId}`);
      
      socket.to(roomId).emit('call-rejected');
    });

    // Unirse a una sala de videollamada (existente)
    socket.on('join-call-room', async (data) => {
      const { callId, userId, userRole } = data;
      
      console.log(`🎥 Usuario ${userId} (${userRole}) uniéndose a sala ${callId}`);
      
      // Unirse a la sala
      socket.join(callId);
      userSocketMap.set(userId.toString(), socket.id); // ✅ Asegurar que userId sea string
      
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
        room.host = userId.toString(); // ✅ Asegurar string
        
        // ✅ NUEVO: Notificar que el host está listo
        socket.to(callId).emit('host-ready');
      } else if (userRole === 'guest') {
        room.guest = userId.toString(); // ✅ Asegurar string
        
        // Notificar al host que el guest se unió
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

    // Señales WebRTC - MEJORADO
    socket.on('webrtc-signal', (data) => {
      const { callId, signal } = data;
      console.log(`📡 Señal WebRTC enviada en sala ${callId}`);
      
      // Reenviar a todos los demás en la sala
      socket.to(callId).emit('webrtc-signal', {
        signal,
        fromUser: socket.id
      });
    });

    // Toggle de cámara del host
    socket.on('toggle-host-camera', (data) => {
      const { callId, enabled } = data;
      const room = rooms.get(callId);
      
      if (room) {
        room.hostCameraEnabled = enabled;
        console.log(`📷 Cámara del host ${enabled ? 'activada' : 'desactivada'} en sala ${callId}`);
        
        // Notificar al guest
        socket.to(callId).emit('host-camera-toggled', { enabled });
      }
    });

    // Toggle de audio - MEJORADO
    socket.on('toggle-audio', (data) => {
      const { callId, enabled } = data;
      const room = rooms.get(callId);
      
      if (room) {
        room.audioEnabled = enabled;
        console.log(`🎤 Audio ${enabled ? 'activado' : 'desactivado'} en sala ${callId}`);
        
        // Notificar a todos en la sala
        io.to(callId).emit('audio-toggled', { 
          enabled, 
          userId: socket.id,
          userRole: room.host === socket.id ? 'host' : 'guest'
        });
      }
    });

    // Finalizar llamada - MEJORADO
    socket.on('end-call', (data) => {
      const { callId, roomId } = data;
      const targetRoom = callId || roomId;
      
      console.log(`📞 Llamada finalizada en sala ${targetRoom}`);
      
      // Notificar a todos en la sala
      io.to(targetRoom).emit('call-ended');
      
      // Limpiar sala si existe en el Map
      if (rooms.has(targetRoom)) {
        rooms.delete(targetRoom);
      }
    });

    // Manejar desconexión - MEJORADO
    socket.on('disconnect', () => {
      console.log('🔌 Usuario desconectado:', socket.id);
      
      // Encontrar y notificar salas donde estaba este usuario
      for (const [callId, room] of rooms.entries()) {
        const userRole = room.host === socket.id ? 'host' : 
                        room.guest === socket.id ? 'guest' : null;
        
        if (userRole) {
          socket.to(callId).emit('user-left', { 
            userId: socket.id,
            userRole 
          });
          
          // Limpiar la referencia del usuario
          if (userRole === 'host') room.host = null;
          else if (userRole === 'guest') room.guest = null;
          
          // Si la sala queda vacía, limpiarla
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

    // ✅ NUEVO: Manejar errores
    socket.on('error', (error) => {
      console.error('❌ Error en socket:', error);
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

module.exports = { initializeWebSocket, getIO };