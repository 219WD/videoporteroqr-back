const express = require('express');
const router = express.Router();
const { authMiddleware, roleGuard } = require('../middleware/auth');
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const { getIO } = require('../websocket-server');

/**
 * Iniciar videollamada automática cuando guest escanea QR
 * POST /videocall/start-automatic
 */
router.post('/start-automatic', authMiddleware, roleGuard('guest'), async (req, res) => {
  try {
    const guest = req.user;

    // Verificar que el guest tenga un host
    if (!guest.hostRef) {
      return res.status(400).json({ error: 'No estás asociado a ningún host' });
    }

    // Buscar host
    const host = await User.findById(guest.hostRef);
    if (!host) {
      return res.status(404).json({ error: 'Host no encontrado' });
    }

    // Crear una nueva llamada de videollamada
    const videoCall = await DoorbellCall.create({
      hostId: host._id,
      guestId: guest._id,
      guestName: guest.name,
      guestEmail: guest.email,
      status: 'pending',
      callType: 'video'
    });

    console.log(`🎥 Videollamada automática iniciada: ${guest.name} -> ${host.name}`);

    // Notificar al host via WebSocket
    const io = getIO();
    io.to(`host-${host._id}`).emit('call-incoming', {
      _id: videoCall._id,
      guestName: guest.name,
      guestEmail: guest.email,
      hostId: host._id,
      createdAt: videoCall.createdAt,
      status: 'pending',
      isAnonymous: false
    });

    res.json({
      success: true,
      callId: videoCall._id,
      hostName: host.name,
      message: 'Llamada iniciada correctamente'
    });

  } catch (error) {
    console.error('Error iniciando videollamada:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error iniciando videollamada',
      details: error.message 
    });
  }
});

/**
 * Aceptar videollamada por parte del host
 * POST /videocall/accept-call
 */
router.post('/accept-call', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const { callId } = req.body;

    const videoCall = await DoorbellCall.findById(callId);
    if (!videoCall) {
      return res.status(404).json({ error: 'Videollamada no encontrada' });
    }

    // Verificar que pertenezca a este host
    if (videoCall.hostId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    // Verificar que la llamada esté pendiente
    if (videoCall.status !== 'pending') {
      return res.status(400).json({ error: 'Esta llamada ya fue respondida' });
    }

    // Actualizar estado
    videoCall.status = 'answered';
    videoCall.response = 'accept';
    videoCall.answeredAt = new Date();
    await videoCall.save();

    // Notificar por WebSocket
    const io = getIO();
    
    // Notificar al guest específico si existe
    if (videoCall.guestId) {
      io.to(`user-${videoCall.guestId}`).emit('call-response', {
        callId,
        response: 'accept'
      });
    }
    
    // Notificar a la sala de la llamada
    io.to(callId).emit('call-response', {
      callId,
      response: 'accept',
      hostName: req.user.name
    });
    
    // Notificar a todos
    io.emit('call-response', {
      callId,
      response: 'accept'
    });

    res.json({
      success: true,
      message: 'Videollamada aceptada',
      call: videoCall
    });

  } catch (error) {
    console.error('Error aceptando videollamada:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error aceptando videollamada' 
    });
  }
});

/**
 * Rechazar videollamada
 * POST /videocall/reject-call
 */
router.post('/reject-call', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const { callId } = req.body;

    const videoCall = await DoorbellCall.findById(callId);
    if (!videoCall) {
      return res.status(404).json({ error: 'Videollamada no encontrada' });
    }

    // Verificar que pertenezca a este host
    if (videoCall.hostId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    // Verificar que la llamada esté pendiente
    if (videoCall.status !== 'pending') {
      return res.status(400).json({ error: 'Esta llamada ya fue respondida' });
    }

    videoCall.status = 'answered';
    videoCall.response = 'reject';
    videoCall.answeredAt = new Date();
    await videoCall.save();

    // Notificar por WebSocket
    const io = getIO();
    
    // Notificar al guest específico si existe
    if (videoCall.guestId) {
      io.to(`user-${videoCall.guestId}`).emit('call-response', {
        callId,
        response: 'reject'
      });
    }
    
    // Notificar a la sala de la llamada
    io.to(callId).emit('call-response', {
      callId,
      response: 'reject'
    });
    
    // Notificar a todos
    io.emit('call-response', {
      callId,
      response: 'reject'
    });

    res.json({
      success: true,
      message: 'Videollamada rechazada',
      call: videoCall
    });

  } catch (error) {
    console.error('Error rechazando videollamada:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error rechazando videollamada' 
    });
  }
});

/**
 * Obtener configuración de videollamada
 * GET /videocall/config/:callId
 */
router.get('/config/:callId', authMiddleware, async (req, res) => {
  try {
    const { callId } = req.params;

    const videoCall = await DoorbellCall.findById(callId);
    if (!videoCall) {
      return res.status(404).json({ 
        success: false,
        error: 'Videollamada no encontrada' 
      });
    }

    // Verificar permisos
    const isHost = req.user._id.toString() === videoCall.hostId.toString();
    const isGuest = videoCall.guestId && 
                   req.user._id.toString() === videoCall.guestId.toString();

    if (!isHost && !isGuest) {
      return res.status(403).json({ 
        success: false,
        error: 'No tienes permisos para esta llamada' 
      });
    }

    res.json({
      success: true,
      call: videoCall,
      userRole: isHost ? 'host' : 'guest'
    });

  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error obteniendo configuración' 
    });
  }
});

// ✅ CORREGIDO el endpoint anonymous-call
router.post('/anonymous-call', async (req, res) => {
  try {
    const { qrCode, guestName = "Visitante Web" } = req.body;
    console.log(`🎥 Llamada anónima recibida con QR: ${qrCode}`);

    if (!qrCode) {
      return res.status(400).json({ 
        success: false,
        error: 'Código QR requerido' 
      });
    }

    // Buscar host por QR code
    const host = await User.findOne({ qrCode, role: 'host' });
    if (!host) {
      console.log(`❌ Host no encontrado para QR: ${qrCode}`);
      return res.status(404).json({ 
        success: false,
        error: 'Host no encontrado' 
      });
    }

    // ✅ CREAR CALL ID ÚNICO
    const callId = `anon-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`✅ Creando llamada con ID: ${callId} para host: ${host.name}`);

    // ✅ Crear llamada con callId como String
    const videoCall = await DoorbellCall.create({
      _id: callId,
      hostId: host._id,
      guestId: null,
      guestName: guestName,
      guestEmail: 'anonimo@visitante.com',
      status: 'pending',
      callType: 'video',
      qrCode: qrCode,
      isAnonymous: true
    });

    console.log(`🔔 Notificando a host: ${host.name} sobre llamada anónima`);
    console.log(`🎯 Llamada creada exitosamente: ${callId}`);

    // ✅ Obtener el io y notificar
    const io = getIO();
    
    // Emitir directamente a la sala del host
    io.to(`host-${host._id}`).emit('call-incoming', {
      _id: callId,
      guestName: guestName,
      guestEmail: 'anonimo@visitante.com',
      hostId: host._id,
      createdAt: new Date().toISOString(),
      status: 'pending',
      isAnonymous: true,
      qrCode: qrCode
    });
    
    console.log(`📢 Notificación enviada a host-${host._id}`);

    // También emitir evento general para polling
    io.emit('new-anonymous-call', {
      callId: callId,
      hostId: host._id.toString(),
      hostName: host.name,
      guestName: guestName
    });

    res.json({
      success: true,
      callId: callId,
      hostId: host._id,
      hostName: host.name,
      message: 'Llamada iniciada correctamente'
    });

  } catch (error) {
    console.error('❌ Error en llamada anónima:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error iniciando videollamada',
      details: error.message 
    });
  }
});

/**
 * Finalizar llamada (para web)
 * POST /videocall/end-call
 */
router.post('/end-call', async (req, res) => {
  try {
    const { callId } = req.body;
    
    if (!callId) {
      return res.status(400).json({ 
        success: false,
        error: 'Call ID requerido' 
      });
    }

    const videoCall = await DoorbellCall.findById(callId);
    if (videoCall) {
      // Actualizar estado si está pendiente
      if (videoCall.status === 'pending') {
        videoCall.status = 'timeout';
        videoCall.response = 'timeout';
        videoCall.answeredAt = new Date();
        await videoCall.save();
        console.log(`📞 Llamada ${callId} marcada como timeout`);
      } else {
        console.log(`📞 Llamada ${callId} finalizada (estado: ${videoCall.status})`);
      }
    } else {
      console.log(`⚠️ Llamada ${callId} no encontrada en DB`);
    }

    // Notificar por WebSocket
    const io = getIO();
    io.to(callId).emit('call-ended');
    io.emit('call-ended', { callId });
    
    res.json({
      success: true,
      message: 'Llamada finalizada'
    });

  } catch (error) {
    console.error('Error finalizando llamada:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error finalizando llamada' 
    });
  }
});

/**
 * Check call status (para web)
 * GET /videocall/check-status/:callId
 */
router.get('/check-status/:callId', async (req, res) => {
  try {
    const { callId } = req.params;
    
    const videoCall = await DoorbellCall.findById(callId);
    if (!videoCall) {
      return res.status(404).json({ 
        success: false,
        error: 'Llamada no encontrada' 
      });
    }

    // Verificar timeout automático (30 segundos)
    const callAge = new Date() - new Date(videoCall.createdAt);
    const thirtySeconds = 30 * 1000;
    
    if (videoCall.status === 'pending' && callAge >= thirtySeconds) {
      console.log(`⏰ Llamada ${callId} marcada como timeout automáticamente (${callAge}ms)`);
      videoCall.status = 'timeout';
      videoCall.response = 'timeout';
      videoCall.answeredAt = new Date();
      await videoCall.save();
    }

    res.json({
      success: true,
      call: {
        _id: videoCall._id,
        status: videoCall.status,
        response: videoCall.response,
        answeredAt: videoCall.answeredAt,
        createdAt: videoCall.createdAt,
        guestName: videoCall.guestName,
        isAnonymous: videoCall.isAnonymous || false
      }
    });

  } catch (error) {
    console.error('Error verificando estado:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error verificando estado de llamada' 
    });
  }
});

/**
 * Unirse a sala de videollamada (para web)
 * POST /videocall/join-call
 */
router.post('/join-call', async (req, res) => {
  try {
    const { callId, userRole = 'guest', userId = null } = req.body;
    
    if (!callId) {
      return res.status(400).json({ 
        success: false,
        error: 'Call ID requerido' 
      });
    }

    // Verificar que la llamada exista
    const videoCall = await DoorbellCall.findById(callId);
    if (!videoCall) {
      return res.status(404).json({ 
        success: false,
        error: 'Llamada no encontrada' 
      });
    }

    // Verificar que la llamada esté aceptada si el usuario es guest
    if (userRole === 'guest' && videoCall.status !== 'answered') {
      return res.status(400).json({ 
        success: false,
        error: 'La llamada no ha sido aceptada aún' 
      });
    }

    // Si es host, verificar permisos
    if (userRole === 'host') {
      const hostId = req.user?._id || userId;
      if (!hostId || hostId.toString() !== videoCall.hostId.toString()) {
        return res.status(403).json({ 
          success: false,
          error: 'No tienes permisos para unirte como host' 
        });
      }
    }

    res.json({
      success: true,
      callId: callId,
      userRole: userRole,
      hostId: videoCall.hostId,
      message: 'Puedes unirte a la videollamada'
    });

  } catch (error) {
    console.error('Error uniéndose a llamada:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error uniéndose a la llamada' 
    });
  }
});

module.exports = router;