const express = require('express');
const router = express.Router();
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const { getIO } = require('../websocket-server');
const { sendExpoPush } = require('../services/notifications');

/**
 * POST /flows/start
 * Inicia flujo con 2 opciones (mensaje o llamada)
 */
router.post('/start', async (req, res) => {
  try {
    const {
      qrCode,
      actionType,
      message,
      guestName = "Visitante",
      isAnonymous = true
    } = req.body;

    console.log('🚀 Iniciando flujo simplificado:', {
      qrCode, actionType, guestName, isAnonymous
    });

    if (!qrCode) {
      return res.status(400).json({
        success: false,
        error: 'Código QR requerido'
      });
    }

    if (!actionType || !['message', 'call'].includes(actionType)) {
      return res.status(400).json({
        success: false,
        error: 'Tipo de acción inválida'
      });
    }

    // Validar que si es mensaje, haya contenido
    if (actionType === 'message' && (!message || message.trim() === '')) {
      return res.status(400).json({
        success: false,
        error: 'Mensaje requerido para flujo de mensaje'
      });
    }

    // Buscar host por QR
    const host = await User.findOne({ qrCode, role: 'host' });
    if (!host) {
      return res.status(404).json({
        success: false,
        error: 'Host no encontrado'
      });
    }

    // Crear callId único
    const callId = `flow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Crear registro en base de datos SIMPLIFICADO
    const doorbellCall = await DoorbellCall.create({
      _id: callId,
      hostId: host._id,
      guestName: guestName,
      status: 'pending',
      callType: actionType === 'call' ? 'video' : 'message',
      actionType: actionType,
      messageContent: message,
      qrCode: qrCode,
      isAnonymous: isAnonymous,
      guestDataProvided: guestName !== 'Visitante', // Datos proporcionados si dio nombre
      pushNotifications: [{
        type: 'initial',
        status: 'sent'
      }],
      firstNotificationAt: new Date(),
      messages: message ? [{
        sender: 'guest',
        message: message,
        timestamp: new Date()
      }] : []
    });

    // Notificación WebSocket SIMPLIFICADA
    const io = getIO();
    let notificationData = {
      type: 'initial',
      actionType: actionType,
      callId: callId,
      guestName: guestName,
      isAnonymous: isAnonymous,
      requiresAction: true,
      timestamp: new Date().toISOString()
    };

    if (actionType === 'call') {
      notificationData.title = '📞 Videollamada entrante';
      notificationData.message = `${guestName} quiere iniciar una videollamada`;
    } else {
      notificationData.title = '📝 Mensaje nuevo';
      notificationData.messagePreview = message ? message.substring(0, 100) + '...' : null;
      notificationData.fullMessage = message;
    }

    io.to(`host-${host._id}`).emit('flow-incoming', notificationData);

    // PUSH NOTIFICATION SIMPLIFICADA
    if (host.pushToken) {
      let title, body, pushData;

      if (actionType === 'call') {
        title = '📞 Llamada entrante';
        body = `${guestName} quiere videollamarte`;
        pushData = {
          type: 'flow',
          actionType: 'call',
          callId: callId,
          guestName: guestName,
          sound: 'ringtone',
          priority: 'max'
        };
      } else {
        title = '📝 Mensaje nuevo';
        body = `${guestName}: ${message ? message.substring(0, 50) + '...' : 'Tiene un mensaje para ti'}`;
        pushData = {
          type: 'flow',
          actionType: 'message',
          callId: callId,
          guestName: guestName,
          sound: 'default',
          priority: 'high'
        };
      }

      try {
        await sendExpoPush(host.pushToken, title, body, pushData);
      } catch (pushError) {
        console.error('❌ Error enviando push:', pushError);
      }
    }

    res.json({
      success: true,
      callId: callId,
      actionType: actionType,
      hostId: host._id,
      hostName: host.name,
      guestData: {
        name: guestName,
        dataProvided: guestName !== 'Visitante'
      },
      message: 'Flujo iniciado correctamente'
    });

  } catch (error) {
    console.error('❌ Error iniciando flujo:', error);
    res.status(500).json({
      success: false,
      error: 'Error iniciando flujo',
      details: error.message
    });
  }
});

/**
 * POST /flows/continue-message
 * Cuando el host selecciona "Mensaje" - Segunda notificación
 */
router.post('/continue-message', async (req, res) => {
  try {
    const { callId, hostId } = req.body;

    console.log('📩 Continuando flujo de mensaje:', { callId, hostId });

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado'
      });
    }

    // Verificar que pertenezca a este host
    if (doorbellCall.hostId.toString() !== hostId.toString()) {
      return res.status(403).json({
        success: false,
        error: 'No autorizado'
      });
    }

    // Verificar que sea un flujo de mensaje
    if (doorbellCall.actionType !== 'message') {
      return res.status(400).json({
        success: false,
        error: 'Este flujo no es de tipo mensaje'
      });
    }

    // ✅ 3. SEGUNDA NOTIFICACIÓN: Mostrar mensaje completo
    const io = getIO();

    const notificationData = {
      type: 'message_details',
      callId: callId,
      guestName: doorbellCall.guestName,
      fullMessage: doorbellCall.messageContent,
      urgency: 'medium',
      requiresResponse: true,
      timestamp: new Date().toISOString()
    };

    io.to(`host-${hostId}`).emit('flow-message-details', notificationData);
    console.log(`📢 Detalles de mensaje enviados a host-${hostId}`);

    // Actualizar en base de datos
    doorbellCall.pushNotifications.push({
      type: 'message_details',
      status: 'sent'
    });
    doorbellCall.secondNotificationAt = new Date();
    await doorbellCall.save();

    // ✅ ENVIAR SEGUNDA PUSH NOTIFICATION
    const host = await User.findById(hostId);
    if (host && host.pushToken) {
      try {
        await sendExpoPush(host.pushToken,
          '📝 Mensaje completo',
          `De ${doorbellCall.guestName}: ${doorbellCall.messageContent}`,
          {
            type: 'message_details',
            callId: callId,
            sound: 'default',
            priority: 'high'
          }
        );
        console.log('✅ Segunda notificación push enviada');
      } catch (pushError) {
        console.error('❌ Error enviando segunda push:', pushError);
      }
    }

    res.json({
      success: true,
      message: 'Detalles del mensaje enviados al host',
      callId: callId,
      guestName: doorbellCall.guestName,
      messageContent: doorbellCall.messageContent
    });

  } catch (error) {
    console.error('❌ Error continuando flujo de mensaje:', error);
    res.status(500).json({
      success: false,
      error: 'Error continuando flujo'
    });
  }
});

/**
 * POST /flows/continue-call
 * Cuando el host selecciona "Llamar" - Iniciar videollamada
 */
router.post('/continue-call', async (req, res) => {
  try {
    const { callId, hostId } = req.body;

    console.log('📞 Continuando flujo de llamada:', { callId, hostId });

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado'
      });
    }

    // Verificar que pertenezca a este host
    if (doorbellCall.hostId.toString() !== hostId.toString()) {
      return res.status(403).json({
        success: false,
        error: 'No autorizado'
      });
    }

    // Verificar que sea un flujo de llamada
    if (doorbellCall.actionType !== 'call') {
      return res.status(400).json({
        success: false,
        error: 'Este flujo no es de tipo llamada'
      });
    }

    // ✅ 4. SEGUNDA NOTIFICACIÓN: Iniciar videollamada
    const io = getIO();

    const notificationData = {
      type: 'start_videocall',
      callId: callId,
      guestName: doorbellCall.guestName,
      urgency: 'high',
      requiresAnswer: true,
      timestamp: new Date().toISOString(),
      webUrl: `/videocall/web?callId=${callId}`
    };

    io.to(`host-${hostId}`).emit('flow-start-videocall', notificationData);
    console.log(`📢 Notificación de videollamada enviada a host-${hostId}`);

    // Actualizar en base de datos
    doorbellCall.pushNotifications.push({
      type: 'start_videocall',
      status: 'sent'
    });
    doorbellCall.secondNotificationAt = new Date();
    doorbellCall.callType = 'video';
    await doorbellCall.save();

    // ✅ ENVIAR SEGUNDA PUSH NOTIFICATION PARA VIDEOLAMADA
    const host = await User.findById(hostId);
    if (host && host.pushToken) {
      try {
        await sendExpoPush(host.pushToken,
          '📞 Videollamada entrante',
          `${doorbellCall.guestName} quiere iniciar una videollamada`,
          {
            type: 'videocall',
            callId: callId,
            sound: 'ringtone',
            priority: 'max'
          }
        );
        console.log('✅ Notificación push de videollamada enviada');
      } catch (pushError) {
        console.error('❌ Error enviando push de videollamada:', pushError);
      }
    }

    // ✅ GUARDAR EN CALL ROOMS (WebSocket)
    const callRooms = io.getCallRooms ? io.getCallRooms() : null;
    if (callRooms) {
      callRooms.set(callId, {
        hostId: hostId.toString(),
        guestId: doorbellCall.guestId || null,
        actionType: 'video_call',
        status: 'pending',
        createdAt: new Date()
      });
      console.log(`✅ Llamada ${callId} registrada en callRooms`);
    }

    res.json({
      success: true,
      callId: callId,
      message: 'Videollamada iniciada',
      webUrl: `/videocall/web?callId=${callId}`,
      socketEvent: 'flow-start-videocall'
    });

  } catch (error) {
    console.error('❌ Error continuando flujo de llamada:', error);
    res.status(500).json({
      success: false,
      error: 'Error iniciando videollamada'
    });
  }
});

/**
 * GET /flows/:callId/messages
 * Obtener mensajes de un flujo específico
 */
router.get('/:callId/messages', async (req, res) => {
  try {
    const { callId } = req.params;

    console.log('📩 Obteniendo mensajes para flujo:', callId);

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado'
      });
    }

    res.json({
      success: true,
      call: {
        _id: doorbellCall._id,
        guestName: doorbellCall.guestName,
        guestEmail: doorbellCall.guestEmail,
        guestPhone: doorbellCall.guestPhone,
        guestCompany: doorbellCall.guestCompany,
        isAnonymous: doorbellCall.isAnonymous,
        guestDataProvided: doorbellCall.guestDataProvided,
        createdAt: doorbellCall.createdAt,
        status: doorbellCall.status,
        actionType: doorbellCall.actionType
      },
      messages: doorbellCall.messages,
      totalMessages: doorbellCall.messages.length
    });

  } catch (error) {
    console.error('❌ Error obteniendo mensajes:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo mensajes'
    });
  }
});

/**
 * POST /flows/:callId/send-message
 * Enviar mensaje adicional a un flujo existente
 */
router.post('/:callId/send-message', async (req, res) => {
  try {
    const { callId } = req.params;
    const { message, sender = 'guest' } = req.body;

    console.log('📝 Enviando mensaje adicional a flujo:', callId, 'Sender:', sender);

    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Mensaje requerido'
      });
    }

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado'
      });
    }

    // Agregar mensaje
    doorbellCall.messages.push({
      sender: sender,
      message: message.trim(),
      timestamp: new Date()
    });

    await doorbellCall.save();

    // Notificar al host del nuevo mensaje
    const io = getIO();
    io.to(`host-${doorbellCall.hostId}`).emit('new-flow-message', {
      callId: callId,
      sender: sender,
      message: message,
      timestamp: new Date().toISOString(),
      guestName: doorbellCall.guestName
    });

    res.json({
      success: true,
      message: 'Mensaje enviado correctamente',
      callId: callId,
      totalMessages: doorbellCall.messages.length
    });

  } catch (error) {
    console.error('❌ Error enviando mensaje:', error);
    res.status(500).json({
      success: false,
      error: 'Error enviando mensaje'
    });
  }
});

/**
 * POST /flows/respond
 * Host responde al flujo - CORREGIDO: emite a sala específica del flujo
 */
router.post('/respond', async (req, res) => {
  try {
    const { callId, response, hostMessage } = req.body;

    console.log('📩 Host respondiendo al flujo:', { callId, response, hostMessage });

    if (!callId || !response) {
      return res.status(400).json({
        success: false,
        error: 'Call ID y respuesta son requeridos'
      });
    }

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado'
      });
    }

    doorbellCall.status = 'answered';
    doorbellCall.response = response;
    doorbellCall.answeredAt = new Date();

    if (hostMessage) {
      doorbellCall.messages.push({
        sender: 'host',
        message: hostMessage,
        timestamp: new Date()
      });
    }

    await doorbellCall.save();

    const io = getIO();
    const responseData = {
      callId: callId,
      response: response,
      hostMessage: hostMessage,
      timestamp: new Date().toISOString()
    };

    // Emitir SOLO a la sala del flujo (guest está escuchando ahí)
    io.to(`flow-${callId}`).emit('flow-response', responseData);
    console.log(`📢 Respuesta del flujo ${callId} enviada al guest: ${response}`);

    // Si es videollamada y aceptada → evento específico
    if (response === 'accept' && doorbellCall.actionType === 'call') {
      io.to(`flow-${callId}`).emit('flow-host-accepted', {
        callId: callId,
        message: 'El anfitrión aceptó la videollamada',
        joinUrl: `/videocall/web?callId=${callId}`
      });
      console.log(`✅ Videollamada ${callId} aceptada, notificando guest para unirse`);
    }

    res.json({
      success: true,
      message: `Respuesta ${response === 'accept' ? 'aceptada' : 'rechazada'} enviada`,
      call: doorbellCall,
      notificationSent: true
    });

  } catch (error) {
    console.error('❌ Error respondiendo al flujo:', error);
    res.status(500).json({
      success: false,
      error: 'Error enviando respuesta'
    });
  }
});

/**
 * GET /flows/status/:callId
 * Verificar estado del flujo
 */
router.get('/status/:callId', async (req, res) => {
  try {
    const { callId } = req.params;

    console.log('🔍 Verificando estado del flujo:', callId);

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado'
      });
    }

    // Verificar timeout (90 segundos para flujo completo)
    const flowAge = new Date() - new Date(doorbellCall.createdAt);
    const timeoutMs = 90 * 1000;

    if (doorbellCall.status === 'pending' && flowAge >= timeoutMs) {
      doorbellCall.status = 'timeout';
      doorbellCall.response = 'timeout';
      doorbellCall.answeredAt = new Date();
      await doorbellCall.save();
      console.log(`⏰ Flujo ${callId} marcado como timeout automáticamente`);
    }

    // Obtener información del host
    const host = await User.findById(doorbellCall.hostId).select('name email');

    res.json({
      success: true,
      call: {
        _id: doorbellCall._id,
        hostId: doorbellCall.hostId,
        guestName: doorbellCall.guestName,
        status: doorbellCall.status,
        response: doorbellCall.response,
        actionType: doorbellCall.actionType,
        callType: doorbellCall.callType,
        messageContent: doorbellCall.messageContent,
        isAnonymous: doorbellCall.isAnonymous,
        createdAt: doorbellCall.createdAt,
        answeredAt: doorbellCall.answeredAt,
        pushNotifications: doorbellCall.pushNotifications,
        messages: doorbellCall.messages
      },
      host: host,
      elapsedSeconds: Math.floor(flowAge / 1000),
      timeoutIn: Math.max(0, timeoutMs - flowAge),
      isTimedOut: flowAge >= timeoutMs && doorbellCall.status === 'pending'
    });

  } catch (error) {
    console.error('❌ Error obteniendo estado del flujo:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estado'
    });
  }
});

/**
 * GET /flows/host/:hostId/pending
 * Obtener flujos pendientes para un host
 */
router.get('/host/:hostId/pending', async (req, res) => {
  try {
    const { hostId } = req.params;

    console.log('🔍 Buscando flujos pendientes para host:', hostId);

    const pendingFlows = await DoorbellCall.find({
      hostId: hostId,
      status: 'pending',
      createdAt: { $gte: new Date(Date.now() - 90 * 1000) } // Solo últimos 90 segundos
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: pendingFlows.length,
      flows: pendingFlows.map(flow => ({
        _id: flow._id,
        guestName: flow.guestName,
        actionType: flow.actionType,
        callType: flow.callType,
        messageContent: flow.messageContent ? flow.messageContent.substring(0, 100) + '...' : null,
        createdAt: flow.createdAt,
        elapsedSeconds: Math.floor((new Date() - new Date(flow.createdAt)) / 1000),
        isAnonymous: flow.isAnonymous
      }))
    });

  } catch (error) {
    console.error('❌ Error obteniendo flujos pendientes:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo flujos pendientes'
    });
  }
});

/**
 * POST /flows/cancel/:callId
 * Cancelar un flujo
 */
router.post('/cancel/:callId', async (req, res) => {
  try {
    const { callId } = req.params;

    console.log('🗑️  Cancelando flujo:', callId);

    const doorbellCall = await DoorbellCall.findById(callId);
    if (!doorbellCall) {
      return res.status(404).json({
        success: false,
        error: 'Flujo no encontrado'
      });
    }

    // Actualizar estado
    doorbellCall.status = 'rejected';
    doorbellCall.response = 'timeout';
    doorbellCall.answeredAt = new Date();
    await doorbellCall.save();

    // Notificar cancelación
    const io = getIO();
    io.emit('flow-cancelled', {
      callId: callId,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Flujo cancelado',
      callId: callId
    });

  } catch (error) {
    console.error('❌ Error cancelando flujo:', error);
    res.status(500).json({
      success: false,
      error: 'Error cancelando flujo'
    });
  }
});

/**
 * GET /flows/history/:hostId
 * Obtener historial de flujos para un host
 */
router.get('/history/:hostId', async (req, res) => {
  try {
    const { hostId } = req.params;
    const { limit = 50, page = 1 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const flows = await DoorbellCall.find({ hostId: hostId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await DoorbellCall.countDocuments({ hostId: hostId });

    res.json({
      success: true,
      flows: flows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo historial:', error);
    res.status(500).json({
      success: false,
      error: 'Error obteniendo historial'
    });
  }
});

module.exports = router;