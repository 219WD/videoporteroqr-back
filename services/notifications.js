const axios = require('axios');
require('dotenv').config();

const EXPO_PUSH_API = process.env.EXPO_PUSH_API || 'https://exp.host/--/api/v2/push/send';

async function sendExpoPush(pushToken, title, body, data = {}) {
  if (!pushToken) {
    console.warn('⚠️ No hay push token para enviar notificación');
    return null;
  }
  
  try {
    // Configurar mensaje según plataforma
    const message = {
      to: pushToken,
      title: title,
      body: body,
      data: data,
      sound: data.sound || 'default',
      priority: data.priority || 'high',
      _displayInForeground: true,
    };
    
    // Configuración específica para Android
    if (data.priority === 'max' || data.sound === 'ringtone') {
      message.android = {
        priority: 'high',
        channelId: 'urgent-notifications',
        vibrate: [100, 200, 100, 200, 100, 400, 100, 200, 100, 200, 100],
        sound: 'ringtone'
      };
      
      message.ios = {
        sound: 'ringtone.wav',
        interruptionLevel: 'critical',
        criticalSound: 1.0
      };
    } else {
      message.android = {
        priority: 'high',
        channelId: 'default-notifications',
        vibrate: [100, 200, 100],
        sound: 'default'
      };
      
      message.ios = {
        sound: 'default',
        interruptionLevel: 'active'
      };
    }
    
    console.log('📤 Enviando notificación push:', {
      to: pushToken.substring(0, 20) + '...',
      title,
      body,
      sound: message.sound,
      priority: message.priority
    });
    
    const res = await axios.post(EXPO_PUSH_API, message, {
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate'
      },
      timeout: 10000
    });
    
    console.log('✅ Notificación push enviada exitosamente:', res.data);
    return res.data;
    
  } catch (err) {
    console.error('❌ Error enviando push:', {
      error: err.message,
      response: err.response?.data,
      token: pushToken ? pushToken.substring(0, 20) + '...' : 'No token'
    });
    return null;
  }
}

// Función para enviar notificación de flujo
async function sendFlowPushNotification(host, flowData) {
  if (!host || !host.pushToken) return null;
  
  const { actionType, guestName, callId, message } = flowData;
  
  let title, body, sound, priority;
  
  if (actionType === 'call') {
    title = '📞 Videollamada entrante';
    body = `${guestName} quiere iniciar una videollamada`;
    sound = 'ringtone';
    priority = 'max';
  } else {
    title = '📝 Mensaje nuevo';
    body = `${guestName}: ${message ? message.substring(0, 50) + '...' : 'Tiene un mensaje para ti'}`;
    sound = 'default';
    priority = 'high';
  }
  
  const data = {
    type: 'flow',
    actionType,
    callId,
    guestName,
    sound,
    priority,
    timestamp: new Date().toISOString()
  };
  
  return await sendExpoPush(host.pushToken, title, body, data);
}

// Función para enviar notificación de detalles de mensaje
async function sendMessageDetailsPush(host, flowData) {
  if (!host || !host.pushToken) return null;
  
  const { guestName, message, callId } = flowData;
  
  const title = '📝 Mensaje completo';
  const body = `De ${guestName}: ${message}`;
  
  const data = {
    type: 'message_details',
    callId,
    guestName,
    sound: 'default',
    priority: 'high',
    timestamp: new Date().toISOString()
  };
  
  return await sendExpoPush(host.pushToken, title, body, data);
}

// Función para enviar notificación de videollamada
async function sendVideoCallPush(host, flowData) {
  if (!host || !host.pushToken) return null;
  
  const { guestName, callId } = flowData;
  
  const title = '📞 Videollamada entrante';
  const body = `${guestName} quiere iniciar una videollamada`;
  
  const data = {
    type: 'videocall',
    callId,
    guestName,
    sound: 'ringtone',
    priority: 'max',
    timestamp: new Date().toISOString()
  };
  
  return await sendExpoPush(host.pushToken, title, body, data);
}

module.exports = { 
  sendExpoPush, 
  sendFlowPushNotification,
  sendMessageDetailsPush,
  sendVideoCallPush 
};