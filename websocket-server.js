const socketIo = require('socket.io');

let io;
let hostRoomsInstance = null;
let roomsInstance = null;
let userSocketMapInstance = null;
let callRoomsInstance = null;

function initializeWebSocket(server) {
  io = socketIo(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const rooms = new Map();
  const userSocketMap = new Map();
  const hostRooms = new Map();
  const callRooms = new Map();
  const flowRooms = new Map();

  roomsInstance = rooms;
  userSocketMapInstance = userSocketMap;
  hostRoomsInstance = hostRooms;
  callRoomsInstance = callRooms;

  io.on('connection', (socket) => {
    console.log('🔌 Usuario conectado:', socket.id);

    // ✅ HOST: Unirse para recibir notificaciones de llamadas
    socket.on('host-join', (data) => {
      const { hostId } = data;
      console.log('🏠 Host unido a notificaciones:', hostId);

      socket.join(`host-${hostId}`);
      hostRooms.set(hostId.toString(), socket.id);

      console.log(`✅ Host ${hostId} listo para recibir notificaciones`);
    });

    // ✅ HOST: Unirse para recibir flujos
    socket.on('host-join-flows', (data) => {
      const { hostId } = data;
      console.log('🏠 Host unido a flujos:', hostId);

      socket.join(`host-flows-${hostId}`);

      console.log(`✅ Host ${hostId} listo para recibir flujos`);
    });

    // ✅ GUEST: Iniciar flujo con mensaje
    // En el evento 'start-message-flow' (línea ~110)
    socket.on('start-message-flow', (data) => {
      const { hostId, message, callId, guestName, guestEmail, guestPhone, guestCompany } = data;
      console.log('📝 START-MESSAGE-FLOW con datos del visitante:', {
        hostId, guestName, guestEmail, guestPhone, guestCompany
      });

      // Guardar en flowRooms con todos los datos
      flowRooms.set(callId, {
        hostId: hostId.toString(),
        actionType: 'message',
        status: 'pending',
        message: message,
        guestName: guestName,
        guestEmail: guestEmail,
        guestPhone: guestPhone,
        guestCompany: guestCompany,
        hasContactInfo: !!(guestName && guestEmail && guestName !== 'Visitante'),
        createdAt: new Date()
      });

      // Emitir notificación inicial al host con todos los datos
      io.to(`host-${hostId}`).emit('flow-incoming', {
        type: 'initial',
        actionType: 'message',
        callId: callId,
        guestName: guestName,
        guestEmail: guestEmail,
        guestPhone: guestPhone,
        guestCompany: guestCompany,
        hasContactInfo: !!(guestName && guestEmail && guestName !== 'Visitante'),
        messagePreview: message ? message.substring(0, 100) + '...' : null,
        urgency: 'high',
        requiresAction: true,
        timestamp: new Date().toISOString()
      });

      console.log(`📢 Notificación de mensaje con datos del visitante enviada a host-${hostId}`);
    });

    // ✅ GUEST: Iniciar flujo con videollamada
    socket.on('start-video-flow', (data) => {
      const { hostId, call, guestName, guestEmail, guestPhone, guestCompany } = data;
      console.log('🎥 START-VIDEO-FLOW con datos del visitante:', {
        hostId, guestName, guestEmail, guestPhone, guestCompany
      });

      // Guardar en flowRooms
      flowRooms.set(call._id, {
        hostId: hostId.toString(),
        actionType: 'call',
        status: 'pending',
        guestName: guestName,
        guestEmail: guestEmail,
        guestPhone: guestPhone,
        guestCompany: guestCompany,
        hasContactInfo: !!(guestName && guestEmail && guestName !== 'Visitante'),
        createdAt: new Date()
      });

      // Guardar también en callRooms para videollamada
      callRooms.set(call._id, {
        hostId: hostId.toString(),
        guestId: call.guestId || null,
        actionType: 'direct_call',
        status: 'pending',
        guestName: guestName,
        guestEmail: guestEmail,
        guestPhone: guestPhone,
        guestCompany: guestCompany,
        createdAt: new Date()
      });

      // Emitir notificación inicial al host
      io.to(`host-${hostId}`).emit('flow-incoming', {
        type: 'initial',
        actionType: 'call',
        callId: call._id,
        guestName: guestName,
        guestEmail: guestEmail,
        guestPhone: guestPhone,
        guestCompany: guestCompany,
        hasContactInfo: !!(guestName && guestEmail && guestName !== 'Visitante'),
        urgency: 'high',
        requiresAction: true,
        timestamp: new Date().toISOString()
      });

      console.log(`📢 Notificación de videollamada con datos del visitante enviada a host-${hostId}`);
    });

    // Agregar después de los eventos existentes
    socket.on('send-flow-message', (data) => {
      const { callId, message, sender = 'guest' } = data;
      console.log(`💬 Mensaje adicional en flujo ${callId} por ${sender}`);

      const flow = flowRooms.get(callId);
      if (flow) {
        // Notificar al host
        io.to(`host-${flow.hostId}`).emit('new-flow-message', {
          callId: callId,
          sender: sender,
          message: message,
          timestamp: new Date().toISOString(),
          guestName: flow.guestName || 'Visitante'
        });

        console.log(`📢 Mensaje adicional notificado a host-${flow.hostId}`);
      }
    });

    // ✅ HOST: Solicitar detalles del mensaje
    socket.on('request-message-details', (data) => {
      const { callId, hostId } = data;
      console.log('📩 Host solicita detalles del mensaje:', callId);

      const flow = flowRooms.get(callId);
      if (flow && flow.actionType === 'message') {
        // Emitir detalles del mensaje al host
        io.to(`host-${hostId}`).emit('flow-message-details', {
          type: 'message_details',
          callId: callId,
          guestName: flow.guestName || 'Visitante',
          fullMessage: flow.message,
          urgency: 'medium',
          requiresResponse: true,
          timestamp: new Date().toISOString()
        });

        console.log(`📢 Detalles de mensaje enviados a host-${hostId}`);
      }
    });

    // ✅ HOST: Solicitar iniciar videollamada
    socket.on('request-start-videocall', (data) => {
      const { callId, hostId } = data;
      console.log('📞 Host solicita iniciar videollamada:', callId);

      const flow = flowRooms.get(callId);
      if (flow && flow.actionType === 'call') {
        // Emitir notificación para iniciar videollamada
        io.to(`host-${hostId}`).emit('flow-start-videocall', {
          type: 'start_videocall',
          callId: callId,
          guestName: flow.guestName || 'Visitante',
          urgency: 'high',
          requiresAnswer: true,
          timestamp: new Date().toISOString()
        });

        console.log(`📢 Notificación de videollamada enviada a host-${hostId}`);
      }
    });

    // ✅ HOST: Responder al flujo
    socket.on('flow-response', (data) => {
      const { callId, response, hostMessage } = data;
      console.log('📩 Host responde al flujo:', callId, 'Respuesta:', response);

      if (flowRooms.has(callId)) {
        const flow = flowRooms.get(callId);
        flow.status = response === 'accept' ? 'answered' : 'rejected';
        flow.response = response;
        flow.answeredAt = new Date();

        // ENVIAR SOLO AL GUEST QUE ESTÁ EN LA SALA flow-${callId}
        io.to(`flow-${callId}`).emit('flow-response', {
          callId,
          response,
          hostMessage,
          timestamp: new Date().toISOString()
        });

        // Si es videollamada y aceptada, enviar evento extra
        if (response === 'accept' && flow.actionType === 'call') {
          io.to(`flow-${callId}`).emit('flow-host-accepted', {
            callId,
            message: 'El anfitrión aceptó la videollamada'
          });
        }

        console.log(`📢 Respuesta enviada SOLO al guest en sala flow-${callId}: ${response}`);
      }
    });

    // ✅ GUEST: Llamar al host - NOTIFICACIÓN EN TIEMPO REAL
    socket.on('call-host', (data) => {
      const { hostId, call } = data;
      console.log('🔔📞 CALL-HOST recibido - Host ID:', hostId, 'Call ID:', call._id);

      // Guardar la llamada en el mapa de calls
      if (call._id) {
        callRooms.set(call._id, {
          hostId: hostId.toString(),
          guestId: call.guestId || null,
          status: 'pending',
          createdAt: new Date()
        });
        console.log(`📝 Call ${call._id} registrada en callRooms`);
      }

      // Verificar si el host está en línea
      const hostSocketId = hostRooms.get(hostId.toString());
      console.log('🔔 Host socket ID encontrado:', hostSocketId);

      if (hostSocketId) {
        // Emitir a todos los sockets del host
        io.to(`host-${hostId}`).emit('call-incoming', call);
        console.log(`📢 Notificación enviada a host-${hostId}`);
      } else {
        console.log(`❌ Host ${hostId} no encontrado en hostRooms`);
      }
    });

    // ✅ HOST: Responder a la llamada
    socket.on('call-response', (data) => {
      const { callId, response } = data;
      console.log('📞 Respuesta del host:', callId, response);

      // Actualizar el estado en callRooms si existe
      if (callRooms.has(callId)) {
        const call = callRooms.get(callId);
        call.status = 'answered';
        call.response = response;
        call.answeredAt = new Date();
        console.log(`📝 Call ${callId} actualizada a ${response}`);
      }

      // Emitir respuesta a todos (el guest estará escuchando)
      io.emit('call-response', {
        callId,
        response
      });
      console.log(`📢 Respuesta del host enviada para call ${callId}: ${response}`);

      // También emitir a la sala específica si existe
      const roomSockets = io.sockets.adapter.rooms.get(callId);
      if (roomSockets) {
        io.to(callId).emit('call-response', {
          callId,
          response
        });
        console.log(`📢 Respuesta también enviada a sala ${callId}`);
      }
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

      if (userId) {
        userSocketMap.set(userId.toString(), socket.id);
      } else {
        console.log(`⚠️ Usuario anónimo uniéndose a sala ${callId}`);
      }

      socket.join(callId);

      if (!rooms.has(callId)) {
        rooms.set(callId, {
          host: null,
          guest: null,
          hostCameraEnabled: false,
          guestCameraEnabled: true,
          audioEnabled: true,
          hostSocket: null,
          guestSocket: null
        });
      }

      const room = rooms.get(callId);

      if (userRole === 'host') {
        room.host = userId.toString();
        room.hostSocket = socket.id;
        console.log(`🏠 Host ${userId} unido a sala ${callId}`);

        io.to(callId).emit('host-ready', {
          callId,
          hostId: userId
        });

      } else if (userRole === 'guest') {
        room.guest = userId.toString();
        room.guestSocket = socket.id;
        console.log(`👤 Guest ${userId} unido a sala ${callId}`);

        io.to(callId).emit('user-joined', {
          userId,
          userRole,
          callId,
          cameraEnabled: room.guestCameraEnabled
        });
      }

      socket.emit('room-config', {
        callId,
        userRole,
        cameraEnabled: userRole === 'guest' ? room.guestCameraEnabled : room.hostCameraEnabled,
        audioEnabled: room.audioEnabled
      });

      console.log(`🔍 Estado sala ${callId}: Host=${room.host ? 'Sí' : 'No'}, Guest=${room.guest ? 'Sí' : 'No'}`);

      if (room.host && room.guest) {
        console.log(`✅ AMBOS USUARIOS EN SALA ${callId}! Notificando conexión...`);

        io.to(callId).emit('call-connected', {
          callId,
          hostId: room.host,
          guestId: room.guest
        });

        io.to(callId).emit('start-webrtc', {
          callId,
          initiator: room.guestSocket
        });
      }
    });

    // ✅ NUEVO: Iniciar oferta WebRTC cuando ambos están conectados
    socket.on('start-webrtc-offer', (data) => {
      const { callId, targetUserId } = data;
      console.log(`🎯 Iniciando WebRTC offer en sala ${callId} para ${targetUserId}`);

      if (targetUserId) {
        io.to(`user-${targetUserId}`).emit('initiate-webrtc', { callId });
      } else {
        socket.to(callId).emit('initiate-webrtc', { callId });
      }
    });

    // ✅ NUEVO: Verificar estado de la sala
    socket.on('check-room-status', (data) => {
      const { callId } = data;
      const room = rooms.get(callId);

      if (room) {
        socket.emit('room-status', {
          callId,
          hostPresent: !!room.host,
          guestPresent: !!room.guest,
          hostSocket: room.hostSocket,
          guestSocket: room.guestSocket
        });
      } else {
        socket.emit('room-status', {
          callId,
          hostPresent: false,
          guestPresent: false
        });
      }
    });

    // ✅ NUEVO: Forzar reconexión de usuarios
    socket.on('request-user-rejoin', (data) => {
      const { callId, userType } = data;
      console.log(`🔄 Solicitando reconexión para ${userType} en sala ${callId}`);

      const room = rooms.get(callId);
      if (room) {
        if (userType === 'host' && room.hostSocket) {
          io.to(room.hostSocket).emit('rejoin-call', { callId });
        } else if (userType === 'guest' && room.guestSocket) {
          io.to(room.guestSocket).emit('rejoin-call', { callId });
        }
      }
    });

    // ✅ ENDPOINT DE DEBUG: Verificar salas
    socket.on('debug-rooms', () => {
      const allRooms = io.sockets.adapter.rooms;
      console.log('🔍 SALAS ACTIVAS:');

      allRooms.forEach((sockets, roomName) => {
        if (!sockets.has(roomName)) {
          console.log(`   - ${roomName}: ${sockets.size} usuarios`);
          console.log(`     Sockets: ${Array.from(sockets)}`);
        }
      });
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

      if (callRooms.has(targetRoom)) {
        callRooms.delete(targetRoom);
      }

      if (flowRooms.has(targetRoom)) {
        flowRooms.delete(targetRoom);
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

    // ✅ NUEVO: Verificar estado de llamada específica
    socket.on('check-call-status', (data) => {
      const { callId } = data;

      if (callRooms.has(callId)) {
        const call = callRooms.get(callId);
        socket.emit('call-status-update', {
          callId,
          status: call.status,
          response: call.response,
          answeredAt: call.answeredAt
        });
      } else {
        socket.emit('call-status-update', {
          callId,
          status: 'not_found'
        });
      }
    });

    // ✅ NUEVO: Verificar estado de flujo
    socket.on('check-flow-status', (data) => {
      const { callId } = data;

      if (flowRooms.has(callId)) {
        const flow = flowRooms.get(callId);
        socket.emit('flow-status-update', {
          callId,
          status: flow.status,
          actionType: flow.actionType,
          response: flow.response,
          answeredAt: flow.answeredAt
        });
      } else {
        socket.emit('flow-status-update', {
          callId,
          status: 'not_found'
        });
      }
    });

    // ✅ GUEST: Unirse a la sala específica del flujo para recibir respuestas en tiempo real
    socket.on('join-flow-room', (data) => {
      const { callId } = data;

      if (!callId) {
        console.warn('⚠️ Intento de unirse a flow sin callId');
        return;
      }

      console.log(`👤 Guest uniéndose a sala de flujo: flow-${callId}`);
      socket.join(`flow-${callId}`);

      // Confirmación opcional al guest
      socket.emit('flow-joined', {
        callId,
        message: 'Conectado al flujo. Esperando respuesta del anfitrión...'
      });

      console.log(`✅ Guest ahora está en la sala flow-${callId} y recibirá respuestas en tiempo real`);
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

      // Limpiar flow rooms
      for (const [callId, flow] of flowRooms.entries()) {
        if (flow.hostSocket === socket.id) {
          flowRooms.delete(callId);
          console.log(`🗑️ Flow ${callId} eliminado por desconexión`);
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
      userConnections: userSocketMap.size,
      trackedCalls: callRooms.size,
      flowRooms: flowRooms.size
    };
  }

  // ✅ FUNCIONES EXPORTABLES
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

  function getFlowRooms() {
    return flowRooms;
  }

  // ✅ EXPORTAR FUNCIONES DE UTILIDAD
  io.notifyHost = notifyHost;
  io.notifyUser = notifyUser;
  io.isHostOnline = isHostOnline;
  io.getServerStats = getServerStats;
  io.getFlowRooms = getFlowRooms;

  console.log('🚀 Servidor WebSocket inicializado correctamente');

  // ✅ LOG PERIÓDICO DE ESTADÍSTICAS
  setInterval(() => {
    const stats = getServerStats();
    console.log('📊 Estadísticas del servidor:', stats);
  }, 60000);

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

module.exports = {
  initializeWebSocket,
  getIO,
  getHostRooms,
  getCallRooms,
  getRooms,
  getUserSocketMap
};