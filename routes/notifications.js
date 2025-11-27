// routes/notifications.js - VERSIÓN CON POLLING
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall'); // Necesitarás crear este modelo
const { authMiddleware, roleGuard } = require('../middleware/auth');

/**
 * Guest calls host (doorbell) - MODIFICADO para guardar en DB
 * POST /notifications/call-host
 */
router.post('/call-host', authMiddleware, roleGuard('guest'), async (req, res) => {
  try {
    const guest = req.user;
    
    // Verificar que el guest tenga un host
    if (!guest.hostRef) {
      return res.status(400).json({ error: 'No estás asociado a ningún host' });
    }

    // Buscar el host
    const host = await User.findById(guest.hostRef);
    if (!host) {
      return res.status(404).json({ error: 'Host no encontrado' });
    }

    // ✅ CREAR REGISTRO EN LA BASE DE DATOS
    const doorbellCall = await DoorbellCall.create({
      hostId: host._id,
      guestId: guest._id,
      guestName: guest.name,
      guestEmail: guest.email,
      status: 'pending'
    });

    console.log(`🚪 Doorbell: ${guest.name} llamó a ${host.name}`, {
      callId: doorbellCall._id,
      timestamp: new Date().toISOString()
    });

    res.json({ 
      success: true, 
      message: 'Llamada enviada al host',
      hostName: host.name,
      callId: doorbellCall._id
    });

  } catch (error) {
    console.error('Error calling host:', error);
    res.status(500).json({ error: 'Error al llamar al host' });
  }
});

// routes/notifications.js - MEJORAR el endpoint de pending-calls
/**
 * Host gets pending calls - MEJORADO con más logs
 * GET /notifications/pending-calls
 */
router.get('/pending-calls', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    
    console.log(`🔍 Buscando llamadas para host: ${hostId}`);
    
    // Solo buscar llamadas de los últimos 5 minutos para evitar spam
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    const pendingCalls = await DoorbellCall.find({
      hostId: hostId,
      status: 'pending',
      createdAt: { $gte: fiveMinutesAgo } // Solo llamadas recientes
    }).sort({ createdAt: -1 });

    console.log(`🔔 Encontradas ${pendingCalls.length} llamadas pendientes recientes para host ${req.user.name}`);
    console.log('🔔 Llamadas encontradas:', pendingCalls);

    res.json(pendingCalls);

  } catch (error) {
    console.error('❌ Error getting pending calls:', error);
    res.status(500).json({ error: 'Error obteniendo llamadas pendientes' });
  }
});

// routes/notifications.js - ARREGLAR el endpoint respond-call
/**
 * Host responds to doorbell call - CORREGIDO
 * POST /notifications/respond-call
 */
router.post('/respond-call', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const { callId, response } = req.body; // response: 'accept' or 'reject'
    
    console.log(`🔔 Respondiendo llamada: ${callId}, respuesta: ${response}`);
    
    if (!callId || !response) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // Buscar la llamada
    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      console.log(`❌ Llamada no encontrada: ${callId}`);
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    // Verificar que la llamada pertenezca a este host
    if (doorbellCall.hostId.toString() !== req.user._id.toString()) {
      console.log(`❌ Permiso denegado: ${doorbellCall.hostId} vs ${req.user._id}`);
      return res.status(403).json({ error: 'Esta llamada no pertenece a tu sala' });
    }

    // Verificar que la llamada esté pendiente
    if (doorbellCall.status !== 'pending') {
      console.log(`❌ Llamada ya respondida: ${doorbellCall.status}`);
      return res.status(400).json({ error: 'Esta llamada ya fue respondida' });
    }

    // Actualizar la llamada
    doorbellCall.status = 'answered';
    doorbellCall.response = response;
    doorbellCall.answeredAt = new Date();
    await doorbellCall.save();

    console.log(`✅ Llamada ${callId} marcada como ${response}`);

    // Buscar el guest para enviar notificación si tiene push token
    const guest = await User.findById(doorbellCall.guestId);
    if (guest && guest.pushToken) {
      const responseMessage = response === 'accept' 
        ? '✅ El host te ha aceptado' 
        : '❌ El host te ha rechazado';

      // Si tienes el servicio de notificaciones, lo puedes mantener para el guest
      // await sendExpoPush(...);
      
      console.log(`📢 Respuesta enviada a guest: ${guest.name} - ${response}`);
    }

    res.json({ 
      success: true, 
      message: `Respuesta ${response === 'accept' ? 'aceptada' : 'rechazada'} enviada`,
      call: doorbellCall
    });

  } catch (error) {
    console.error('❌ Error responding to call:', error);
    res.status(500).json({ error: 'Error al responder la llamada' });
  }
});

/**
 * Clean old calls - ✅ ENDPOINT OPCIONAL para limpiar llamadas viejas
 * POST /notifications/clean-old-calls
 */
router.post('/clean-old-calls', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    
    // Eliminar llamadas con más de 1 hora
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const result = await DoorbellCall.deleteMany({
      hostId: hostId,
      createdAt: { $lt: oneHourAgo }
    });

    console.log(`🧹 Limpiadas ${result.deletedCount} llamadas antiguas`);

    res.json({ 
      success: true, 
      message: `Limpiadas ${result.deletedCount} llamadas antiguas` 
    });

  } catch (error) {
    console.error('Error cleaning old calls:', error);
    res.status(500).json({ error: 'Error limpiando llamadas' });
  }
});

// routes/notifications.js - Añade este endpoint
/**
 * Get call history for host
 * GET /notifications/call-history
 */
router.get('/call-history', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    const { page = 1, limit = 20 } = req.query;
    
    const calls = await DoorbellCall.find({ hostId: hostId })
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await DoorbellCall.countDocuments({ hostId: hostId });
    
    res.json({
      calls,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
    
  } catch (error) {
    console.error('Error getting call history:', error);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// routes/notifications.js - TIMEOUT MÁS RÁPIDO
/**
 * Get call status for guest - MEJORADO con timeout más rápido
 * GET /notifications/call-status/:callId
 */
router.get('/call-status/:callId', authMiddleware, async (req, res) => {
  try {
    const { callId } = req.params;
    
    console.log(`🔍 Buscando estado de llamada: ${callId}`);
    
    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      console.log(`❌ Llamada no encontrada: ${callId}`);
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }

    // Verificar que el usuario tenga permisos (solo el guest que hizo la llamada)
    const isGuest = req.user._id.toString() === doorbellCall.guestId.toString();
    if (!isGuest) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    // ✅ TIMEOUT AUTOMÁTICO DESPUÉS DE 30 SEGUNDOS (no 2 minutos)
    const callAge = new Date() - new Date(doorbellCall.createdAt);
    const thirtySeconds = 30 * 1000;
    
    if (doorbellCall.status === 'pending' && callAge >= thirtySeconds) {
      console.log(`⏰ Llamada ${callId} marcada como timeout automáticamente (${callAge}ms)`);
      doorbellCall.status = 'timeout';
      await doorbellCall.save();
    }

    console.log(`✅ Estado de llamada: ${doorbellCall.status}`);
    
    res.json(doorbellCall);

  } catch (error) {
    console.error('❌ Error getting call status:', error);
    res.status(500).json({ error: 'Error obteniendo estado de llamada' });
  }
});

module.exports = router;