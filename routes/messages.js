// routes/messages.js - Crear este nuevo archivo
const express = require('express');
const router = express.Router();
const DoorbellCall = require('../models/DoorbellCall');
const User = require('../models/User');
const { authMiddleware, roleGuard } = require('../middleware/auth');

/**
 * Get all calls with messages for user
 * GET /messages/my-calls
 */
router.get('/my-calls', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const userRole = req.user.role;

    let calls;
    
    if (userRole === 'host') {
      calls = await DoorbellCall.find({ 
        hostId: userId,
        status: { $in: ['answered', 'timeout'] },
        $or: [
          { 'messages.0': { $exists: true } }, // Tiene mensajes
          { response: 'reject' } // O fue rechazada
        ]
      }).sort({ updatedAt: -1 });
    } else if (userRole === 'guest') {
      calls = await DoorbellCall.find({ 
        guestId: userId,
        status: { $in: ['answered', 'timeout'] },
        $or: [
          { 'messages.0': { $exists: true } }, // Tiene mensajes
          { response: 'reject' } // O fue rechazada
        ]
      }).sort({ updatedAt: -1 });
    } else {
      return res.status(403).json({ error: 'Rol no permitido' });
    }

    res.json({
      success: true,
      calls: calls
    });

  } catch (error) {
    console.error('Error getting user calls:', error);
    res.status(500).json({ error: 'Error obteniendo llamadas' });
  }
});

/**
 * Get messages for a call
 * GET /messages/:callId
 */
router.get('/:callId', authMiddleware, async (req, res) => {
  try {
    const { callId } = req.params;

    // Verificar que callId no sea "my-calls"
    if (callId === 'my-calls') {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    // Verificar permisos
    const isHost = req.user._id.toString() === doorbellCall.hostId.toString();
    const isGuest = req.user._id.toString() === doorbellCall.guestId.toString();
    
    if (!isHost && !isGuest) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    res.json({
      success: true,
      call: doorbellCall,
      messages: doorbellCall.messages
    });

  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: 'Error obteniendo mensajes' });
  }
});


// routes/messages.js - PERMITIR MENSAJES DESPUÉS DE TIMEOUT
/**
 * Send message to call - MODIFICADO para permitir mensajes después de timeout
 * POST /messages/send
 * body: { callId, message }
 */
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { callId, message } = req.body;
    
    if (!callId || !message) {
      return res.status(400).json({ error: 'Call ID y mensaje son requeridos' });
    }

    // Buscar la llamada
    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    // Verificar permisos
    const isHost = req.user._id.toString() === doorbellCall.hostId.toString();
    const isGuest = req.user._id.toString() === doorbellCall.guestId.toString();
    
    if (!isHost && !isGuest) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    // ✅ PERMITIR MENSAJES EN CUALQUIER ESTADO: pending, answered, timeout
    // Solo restringir si es guest y la llamada está pendiente por menos de 30 segundos
    const callAge = new Date() - new Date(doorbellCall.createdAt);
    const thirtySeconds = 30 * 1000;
    
    if (isGuest && doorbellCall.status === 'pending' && callAge < thirtySeconds) {
      return res.status(400).json({ 
        error: 'Espera al menos 30 segundos antes de enviar un mensaje' 
      });
    }

    // ✅ SI ES GUEST Y LA LLAMADA SIGUE PENDIENTE DESPUÉS DE 30 SEGUNDOS, MARCAR COMO TIMEOUT
    if (isGuest && doorbellCall.status === 'pending' && callAge >= thirtySeconds) {
      doorbellCall.status = 'timeout';
      console.log(`⏰ Llamada ${callId} marcada como timeout automáticamente para mensajes`);
    }

    // Añadir mensaje
    doorbellCall.messages.push({
      sender: isHost ? 'host' : 'guest',
      message: message.trim(),
      timestamp: new Date()
    });

    await doorbellCall.save();

    res.json({ 
      success: true, 
      message: 'Mensaje enviado',
      call: doorbellCall
    });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Error enviando mensaje' });
  }
});

/**
 * Get messages for a call
 * GET /messages/:callId
 */
router.get('/:callId', authMiddleware, async (req, res) => {
  try {
    const { callId } = req.params;

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    // Verificar permisos
    const isHost = req.user._id.toString() === doorbellCall.hostId.toString();
    const isGuest = req.user._id.toString() === doorbellCall.guestId.toString();
    
    if (!isHost && !isGuest) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    res.json({
      success: true,
      call: doorbellCall,
      messages: doorbellCall.messages
    });

  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: 'Error obteniendo mensajes' });
  }
});

// routes/messages.js - AÑADIR endpoint para crear conversación
/**
 * Create new conversation (when call times out)
 * POST /messages/new-conversation
 */
router.post('/new-conversation', authMiddleware, async (req, res) => {
  try {
    const { hostId } = req.body;
    
    if (!hostId) {
      return res.status(400).json({ error: 'Host ID requerido' });
    }

    // Verificar que el guest esté en esta sala
    if (req.user.hostRef?.toString() !== hostId) {
      return res.status(403).json({ error: 'No estás en esta sala' });
    }

    // Crear una nueva "llamada" para mensajes
    const doorbellCall = await DoorbellCall.create({
      hostId: hostId,
      guestId: req.user._id,
      guestName: req.user.name,
      guestEmail: req.user.email,
      status: 'answered',
      response: 'accept', // Para permitir mensajes
      answeredAt: new Date(),
      messages: [],
      timeoutAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 horas
    });

    res.json({
      success: true,
      call: doorbellCall,
      message: 'Conversación creada'
    });

  } catch (error) {
    console.error('Error creating conversation:', error);
    res.status(500).json({ error: 'Error creando conversación' });
  }
});

module.exports = router;