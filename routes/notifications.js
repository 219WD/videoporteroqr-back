// routes/notifications.js - VERSIÓN COMPLETA CORREGIDA (CON HISTORIAL)
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const { getIO } = require('../websocket-server');

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

    // Notificar al host por WebSocket si está conectado
    const io = getIO();
    io.to(`host-${host._id}`).emit('call-incoming', {
      _id: doorbellCall._id,
      guestName: guest.name,
      guestEmail: guest.email,
      hostId: host._id,
      createdAt: doorbellCall.createdAt,
      status: 'pending'
    });

    res.json({ 
      success: true, 
      message: 'Llamada enviada al host',
      hostName: host.name,
      callId: doorbellCall._id
    });

  } catch (error) {
    console.error('Error calling host:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al llamar al host' 
    });
  }
});

/**
 * Host gets pending calls - MEJORADO con más logs
 * GET /notifications/pending-calls
 */
router.get('/pending-calls', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    
    console.log(`🔍 Buscando llamadas pendientes para host: ${req.user.name} (${hostId})`);
    
    // Buscar TODAS las llamadas pendientes (sin límite de tiempo)
    const pendingCalls = await DoorbellCall.find({
      hostId: hostId,
      status: 'pending'
    }).sort({ createdAt: -1 });

    console.log(`🔔 Encontradas ${pendingCalls.length} llamadas pendientes`);
    
    // Formatear respuesta
    const formattedCalls = pendingCalls.map(call => ({
      _id: call._id,
      guestName: call.guestName,
      guestEmail: call.guestEmail,
      createdAt: call.createdAt,
      isAnonymous: call.isAnonymous || false,
      callType: call.callType || 'doorbell',
      guestId: call.guestId
    }));

    res.json({
      success: true,
      calls: formattedCalls,
      count: pendingCalls.length
    });

  } catch (error) {
    console.error('❌ Error getting pending calls:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error obteniendo llamadas pendientes' 
    });
  }
});

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

    // Buscar la llamada - ✅ IMPORTANTE: Buscar por _id que es String
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

    // ✅ NOTIFICAR POR WEBSOCKET A TODOS (INCLUYENDO WEB)
    const io = getIO();
    io.emit('call-response', {
      callId: callId,
      response: response,
      hostName: req.user.name
    });

    // Si la llamada es anónima, también emitir a la sala específica
    if (doorbellCall.isAnonymous) {
      io.to(callId).emit('call-response', {
        callId: callId,
        response: response
      });
    }

    // Notificar al guest específico si tiene guestId
    if (doorbellCall.guestId) {
      io.to(`user-${doorbellCall.guestId}`).emit('call-response', {
        callId: callId,
        response: response
      });
    }

    res.json({ 
      success: true, 
      message: `Respuesta ${response === 'accept' ? 'aceptada' : 'rechazada'} enviada`,
      call: doorbellCall
    });

  } catch (error) {
    console.error('❌ Error responding to call:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al responder la llamada' 
    });
  }
});

/**
 * Mark old pending calls as timeout (NO ELIMINA - SOLO CAMBIA ESTADO)
 * POST /notifications/mark-old-timeout
 */
router.post('/mark-old-timeout', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    
    // Marcar como timeout llamadas pendientes con más de 1 HORA
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const result = await DoorbellCall.updateMany(
      {
        hostId: hostId,
        status: 'pending',
        createdAt: { $lt: oneHourAgo }
      },
      {
        $set: {
          status: 'timeout',
          response: 'timeout',
          timeoutReason: 'auto_timeout_after_1h',
          answeredAt: new Date() // Marcar como respondida ahora
        }
      }
    );

    console.log(`⏰ Marcadas ${result.modifiedCount} llamadas antiguas como timeout (NO eliminadas)`);

    res.json({ 
      success: true, 
      message: `Completado: ${result.modifiedCount} llamadas marcadas como timeout`,
      details: 'Los registros se mantienen en el historial'
    });

  } catch (error) {
    console.error('Error marking old calls as timeout:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error procesando llamadas antiguas' 
    });
  }
});

/**
 * Get call history for host (CON PAGINACIÓN Y FILTROS)
 * GET /notifications/call-history
 */
router.get('/call-history', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    const { 
      page = 1, 
      limit = 20,
      status, // Opcional: 'pending', 'answered', 'timeout', 'all'
      startDate,
      endDate 
    } = req.query;
    
    // Construir filtro
    const filter = { hostId: hostId };
    
    if (status && status !== 'all') {
      filter.status = status;
    }
    
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }
    
    const calls = await DoorbellCall.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await DoorbellCall.countDocuments(filter);
    
    // Estadísticas adicionales
    const stats = await DoorbellCall.aggregate([
      { $match: { hostId: hostId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Totales por tipo de respuesta
    const totals = {
      pending: await DoorbellCall.countDocuments({ hostId: hostId, status: 'pending' }),
      answered: await DoorbellCall.countDocuments({ hostId: hostId, status: 'answered' }),
      timeout: await DoorbellCall.countDocuments({ hostId: hostId, status: 'timeout' }),
      accepted: await DoorbellCall.countDocuments({ 
        hostId: hostId, 
        status: 'answered',
        response: 'accept'
      }),
      rejected: await DoorbellCall.countDocuments({ 
        hostId: hostId, 
        status: 'answered',
        response: 'reject'
      })
    };
    
    res.json({
      success: true,
      calls,
      pagination: {
        totalPages: Math.ceil(total / limit),
        currentPage: parseInt(page),
        totalCalls: total,
        limit: parseInt(limit)
      },
      statistics: stats.reduce((acc, curr) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {}),
      totals: totals,
      summary: {
        totalAnswered: totals.answered,
        answerRate: total > 0 ? ((totals.answered / total) * 100).toFixed(1) + '%' : '0%',
        acceptanceRate: totals.answered > 0 ? 
          ((totals.accepted / totals.answered) * 100).toFixed(1) + '%' : '0%'
      }
    });
    
  } catch (error) {
    console.error('Error getting call history:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error obteniendo historial' 
    });
  }
});

/**
 * Get call status for guest
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

    // Verificar que el usuario tenga permisos
    const isGuest = doorbellCall.guestId && 
                   req.user._id.toString() === doorbellCall.guestId.toString();
    const isHost = req.user._id.toString() === doorbellCall.hostId.toString();
    
    if (!isGuest && !isHost) {
      return res.status(403).json({ error: 'No tienes permisos para esta llamada' });
    }

    // ✅ TIMEOUT AUTOMÁTICO DESPUÉS DE 30 SEGUNDOS para guests
    if (isGuest && doorbellCall.status === 'pending') {
      const callAge = new Date() - new Date(doorbellCall.createdAt);
      const thirtySeconds = 30 * 1000;
      
      if (callAge >= thirtySeconds) {
        console.log(`⏰ Llamada ${callId} marcada como timeout automáticamente (${callAge}ms)`);
        doorbellCall.status = 'timeout';
        doorbellCall.response = 'timeout';
        await doorbellCall.save();
      }
    }

    console.log(`✅ Estado de llamada: ${doorbellCall.status}`);
    
    res.json({
      success: true,
      call: doorbellCall,
      userRole: isHost ? 'host' : 'guest'
    });

  } catch (error) {
    console.error('❌ Error getting call status:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error obteniendo estado de llamada' 
    });
  }
});

/**
 * Search in call history
 * GET /notifications/search-history
 */
router.get('/search-history', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    const { q, status, dateFrom, dateTo } = req.query;
    
    const filter = { hostId: hostId };
    
    // Búsqueda por texto
    if (q) {
      filter.$or = [
        { guestName: { $regex: q, $options: 'i' } },
        { guestEmail: { $regex: q, $options: 'i' } },
        { _id: { $regex: q, $options: 'i' } }
      ];
    }
    
    // Filtrar por status
    if (status && status !== 'all') {
      filter.status = status;
    }
    
    // Filtrar por fecha
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }
    
    const calls = await DoorbellCall.find(filter)
      .sort({ createdAt: -1 })
      .limit(100);
    
    res.json({
      success: true,
      count: calls.length,
      calls: calls,
      searchParams: { q, status, dateFrom, dateTo }
    });
    
  } catch (error) {
    console.error('Error searching history:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error buscando en historial' 
    });
  }
});

/**
 * Get full statistics for dashboard
 * GET /notifications/statistics
 */
router.get('/statistics', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    
    // Totales por día (últimos 7 días)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const dailyStats = await DoorbellCall.aggregate([
      {
        $match: {
          hostId: hostId,
          createdAt: { $gte: sevenDaysAgo }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
          },
          total: { $sum: 1 },
          answered: {
            $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] }
          },
          accepted: {
            $sum: { $cond: [{ $eq: ["$response", "accept"] }, 1, 0] }
          }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);
    
    // Estadísticas generales
    const totalCalls = await DoorbellCall.countDocuments({ hostId: hostId });
    const answeredCalls = await DoorbellCall.countDocuments({ 
      hostId: hostId, 
      status: 'answered' 
    });
    const acceptedCalls = await DoorbellCall.countDocuments({ 
      hostId: hostId, 
      response: 'accept' 
    });
    const anonymousCalls = await DoorbellCall.countDocuments({ 
      hostId: hostId, 
      isAnonymous: true 
    });
    
    // Última llamada
    const lastCall = await DoorbellCall.findOne({ hostId: hostId })
      .sort({ createdAt: -1 })
      .limit(1);
    
    res.json({
      success: true,
      statistics: {
        totals: {
          all: totalCalls,
          answered: answeredCalls,
          accepted: acceptedCalls,
          anonymous: anonymousCalls,
          pending: await DoorbellCall.countDocuments({ hostId: hostId, status: 'pending' }),
          timeout: await DoorbellCall.countDocuments({ hostId: hostId, status: 'timeout' })
        },
        rates: {
          answerRate: totalCalls > 0 ? ((answeredCalls / totalCalls) * 100).toFixed(1) : 0,
          acceptanceRate: answeredCalls > 0 ? ((acceptedCalls / answeredCalls) * 100).toFixed(1) : 0
        },
        daily: dailyStats,
        lastCall: lastCall ? {
          id: lastCall._id,
          guestName: lastCall.guestName,
          status: lastCall.status,
          timeAgo: formatTimeAgo(lastCall.createdAt)
        } : null
      }
    });
    
  } catch (error) {
    console.error('Error getting statistics:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error obteniendo estadísticas' 
    });
  }
});

/**
 * Export call history to JSON
 * GET /notifications/export-history
 */
router.get('/export-history', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const hostId = req.user._id;
    const { format = 'json' } = req.query;
    
    const calls = await DoorbellCall.find({ hostId: hostId })
      .sort({ createdAt: -1 })
      .lean();
    
    // Siempre exportar como JSON (sin CSV que podría ser pesado)
    res.json({
      success: true,
      exportDate: new Date().toISOString(),
      hostId: hostId,
      hostName: req.user.name,
      totalCalls: calls.length,
      calls: calls.map(call => ({
        ...call,
        // Añadir campos formateados
        createdAtFormatted: new Date(call.createdAt).toLocaleString('es-ES'),
        answeredAtFormatted: call.answeredAt ? 
          new Date(call.answeredAt).toLocaleString('es-ES') : null
      }))
    });
    
  } catch (error) {
    console.error('Error exporting history:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error exportando historial' 
    });
  }
});

/**
 * Delete SINGLE call (solo para admin o host específico)
 * DELETE /notifications/delete-call/:callId
 */
router.delete('/delete-call/:callId', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const { callId } = req.params;
    const hostId = req.user._id;
    
    console.log(`🗑️  Solicitando eliminación de llamada: ${callId}`);
    
    // Buscar la llamada
    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({ error: 'Llamada no encontrada' });
    }
    
    // Verificar permisos
    if (doorbellCall.hostId.toString() !== hostId.toString()) {
      return res.status(403).json({ error: 'No tienes permisos para eliminar esta llamada' });
    }
    
    // SOLO permitir eliminar llamadas muy antiguas (más de 30 días)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (doorbellCall.createdAt > thirtyDaysAgo) {
      return res.status(400).json({ 
        error: 'Solo puedes eliminar llamadas con más de 30 días de antigüedad',
        minAgeRequired: '30 días',
        callAge: formatTimeAgo(doorbellCall.createdAt)
      });
    }
    
    // Eliminar (esto es OPCIONAL - normalmente no deberías eliminar)
    await DoorbellCall.findByIdAndDelete(callId);
    
    console.log(`✅ Llamada ${callId} eliminada del historial`);
    
    res.json({
      success: true,
      message: 'Llamada eliminada del historial',
      warning: 'Esta acción no se puede deshacer',
      callDeleted: {
        id: callId,
        guestName: doorbellCall.guestName,
        createdAt: doorbellCall.createdAt,
        status: doorbellCall.status
      }
    });
    
  } catch (error) {
    console.error('Error deleting call:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error eliminando llamada' 
    });
  }
});

// Función helper para formatear tiempo
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  
  let interval = Math.floor(seconds / 31536000);
  if (interval >= 1) return interval + (interval === 1 ? ' año' : ' años');
  
  interval = Math.floor(seconds / 2592000);
  if (interval >= 1) return interval + (interval === 1 ? ' mes' : ' meses');
  
  interval = Math.floor(seconds / 86400);
  if (interval >= 1) return interval + (interval === 1 ? ' día' : ' días');
  
  interval = Math.floor(seconds / 3600);
  if (interval >= 1) return interval + (interval === 1 ? ' hora' : ' horas');
  
  interval = Math.floor(seconds / 60);
  if (interval >= 1) return interval + (interval === 1 ? ' minuto' : ' minutos');
  
  return 'hace ' + Math.floor(seconds) + ' segundos';
}

module.exports = router;