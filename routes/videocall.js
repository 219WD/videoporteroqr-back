// routes/videocall.js
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

    // Crear una nueva llamada de videollamada
    const videoCall = await DoorbellCall.create({
      hostId: guest.hostRef,
      guestId: guest._id,
      guestName: guest.name,
      guestEmail: guest.email,
      status: 'pending',
      callType: 'video' // Nuevo campo para identificar videollamadas
    });

    console.log(`🎥 Videollamada automática iniciada: ${guest.name} -> Host`);

    // Notificar al host via WebSocket si está conectado
    const io = getIO();
    io.to(guest.hostRef.toString()).emit('incoming-video-call', {
      callId: videoCall._id,
      guestName: guest.name,
      guestId: guest._id
    });

    res.json({
      success: true,
      callId: videoCall._id,
      message: 'Videollamada iniciada automáticamente'
    });

  } catch (error) {
    console.error('Error iniciando videollamada:', error);
    res.status(500).json({ error: 'Error iniciando videollamada' });
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

    // Actualizar estado
    videoCall.status = 'answered';
    videoCall.answeredAt = new Date();
    await videoCall.save();

    // Notificar al guest que la llamada fue aceptada
    const io = getIO();
    io.to(callId).emit('video-call-accepted', {
      callId,
      hostName: req.user.name
    });

    res.json({
      success: true,
      message: 'Videollamada aceptada'
    });

  } catch (error) {
    console.error('Error aceptando videollamada:', error);
    res.status(500).json({ error: 'Error aceptando videollamada' });
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

    videoCall.status = 'answered';
    videoCall.response = 'reject';
    videoCall.answeredAt = new Date();
    await videoCall.save();

    // Notificar al guest
    const io = getIO();
    io.to(callId).emit('video-call-rejected');

    res.json({
      success: true,
      message: 'Videollamada rechazada'
    });

  } catch (error) {
    console.error('Error rechazando videollamada:', error);
    res.status(500).json({ error: 'Error rechazando videollamada' });
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
      return res.status(404).json({ error: 'Videollamada no encontrada' });
    }

    // Verificar permisos
    const isHost = req.user._id.toString() === videoCall.hostId.toString();
    const isGuest = req.user._id.toString() === videoCall.guestId.toString();
    
    if (!isHost && !isGuest) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    res.json({
      success: true,
      call: videoCall,
      userRole: isHost ? 'host' : 'guest'
    });

  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    res.status(500).json({ error: 'Error obteniendo configuración' });
  }
});

// routes/videocall.js - CORREGIR el endpoint anonymous-call
router.post('/anonymous-call', async (req, res) => {
  try {
    const { qrCode, guestName = "Visitante" } = req.body;
    
    console.log(`🎥 Llamada anónima recibida con QR: ${qrCode}`);
    
    if (!qrCode) {
      return res.status(400).json({ error: 'Código QR requerido' });
    }

    // Buscar host por QR code
    const host = await User.findOne({ qrCode, role: 'host' });
    if (!host) {
      console.log(`❌ Host no encontrado para QR: ${qrCode}`);
      return res.status(404).json({ error: 'Host no encontrado' });
    }

    // ✅ CORREGIDO: Crear llamada con guestId como null o string vacío
    const videoCall = await DoorbellCall.create({
      hostId: host._id,
      guestId: null, // ✅ Para llamadas anónimas
      guestName: guestName,
      guestEmail: 'anonimo@visitante.com',
      status: 'pending',
      callType: 'video',
    });

    console.log(`🔔 Notificando a host: ${host.name} sobre llamada anónima`);

    // Notificar al host via WebSocket
    const io = getIO();
    io.to(host._id.toString()).emit('call-incoming', {
      _id: videoCall._id,
      guestName: guestName,
      guestEmail: 'anonimo@visitante.com',
      hostId: host._id,
      createdAt: new Date().toISOString(),
      status: 'pending',
      isAnonymous: true
    });

    res.json({ 
      success: true,
      callId: videoCall._id,
      hostName: host.name,
      message: 'Llamada iniciada correctamente'
    });

  } catch (error) {
    console.error('❌ Error en llamada anónima:', error);
    res.status(500).json({ error: 'Error iniciando videollamada' });
  }
});


module.exports = router;