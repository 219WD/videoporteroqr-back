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
    const { qrCode, actionType, message, guestName = "Visitante", isAnonymous = true } = req.body;
    
    console.log('🚀 Iniciando flujo:', { qrCode, actionType, message, guestName, isAnonymous });
    
    if (!qrCode) {
      return res.status(400).json({ 
        success: false,
        error: 'Código QR requerido' 
      });
    }
    
    if (!actionType || !['message', 'call'].includes(actionType)) {
      return res.status(400).json({ 
        success: false,
        error: 'Tipo de acción inválida. Debe ser "message" o "call"' 
      });
    }
    
    // Buscar host por QR
    const host = await User.findOne({ qrCode, role: 'host' });
    if (!host) {
      console.log('❌ Host no encontrado para QR:', qrCode);
      return res.status(404).json({ 
        success: false,
        error: 'Host no encontrado' 
      });
    }
    
    console.log('✅ Host encontrado:', host.name, 'ID:', host._id);
    
    // Crear callId único
    const callId = `flow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Crear registro en base de datos
    const doorbellCall = await DoorbellCall.create({
      _id: callId,
      hostId: host._id,
      guestId: null,
      guestName: guestName,
      guestEmail: isAnonymous ? 'anonimo@visitante.com' : req.user?.email || 'web@visitante.com',
      status: 'pending',
      callType: actionType === 'call' ? 'video' : 'message',
      actionType: actionType,
      messageContent: actionType === 'message' ? message : null,
      qrCode: qrCode,
      isAnonymous: isAnonymous,
      pushNotifications: [{
        type: 'initial',
        status: 'sent'
      }],
      firstNotificationAt: new Date()
    });
    
    console.log('✅ Registro creado en DB:', callId);
    
    // Obtener WebSocket
    const io = getIO();
    
    // ✅ 1. PRIMERA NOTIFICACIÓN: Sonido y vibración fuerte
    let notificationData = {
      type: 'initial',
      actionType: actionType,
      callId: callId,
      guestName: guestName,
      urgency: 'high',
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
    
    // Enviar notificación por WebSocket
    io.to(`host-${host._id}`).emit('flow-incoming', notificationData);
    console.log(`📢 Notificación WebSocket enviada a host-${host._id}`);
    
    // ✅ 2. ENVIAR NOTIFICACIÓN PUSH
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
        console.log('✅ Notificación push enviada');
        
        // Actualizar estado en DB
        doorbellCall.pushNotifications.push({
          type: 'push',
          status: 'sent'
        });
        await doorbellCall.save();
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
      message: 'Flujo iniciado correctamente',
      nextStep: actionType === 'message' ? 'waiting_for_host_response' : 'ready_for_videocall'
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
 * POST /flows/respond
 * Host responde al flujo
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
    
    // Actualizar estado
    doorbellCall.status = 'answered';
    doorbellCall.response = response;
    doorbellCall.answeredAt = new Date();
    
    // Si el host envía un mensaje como respuesta
    if (hostMessage) {
      doorbellCall.messages.push({
        sender: 'host',
        message: hostMessage,
        timestamp: new Date()
      });
    }
    
    await doorbellCall.save();
    
    // Notificar al guest vía WebSocket
    const io = getIO();
    const responseData = {
      callId: callId,
      response: response,
      hostMessage: hostMessage,
      timestamp: new Date().toISOString()
    };
    
    io.emit('flow-response', responseData);
    console.log(`📢 Respuesta del flujo ${callId} enviada: ${response}`);
    
    // Si es videollamada y fue aceptada, notificar para unirse
    if (response === 'accept' && doorbellCall.callType === 'video') {
      io.emit('video-call-ready', {
        callId: callId,
        hostId: doorbellCall.hostId,
        guestName: doorbellCall.guestName,
        message: 'El host aceptó la videollamada',
        joinUrl: `/videocall/web?callId=${callId}`
      });
      console.log(`✅ Videollamada ${callId} aceptada, notificando guest`);
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