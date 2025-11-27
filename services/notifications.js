const axios = require('axios');
require('dotenv').config();

const EXPO_PUSH_API = process.env.EXPO_PUSH_API;

// services/notifications.js - Actualiza la función sendExpoPush
async function sendExpoPush(pushToken, title, body, data = {}) {
  if (!pushToken) return;
  try {
    const message = {
      to: pushToken,
      sound: 'default', // Esto usará el sonido por defecto, pero queremos personalizado
      title,
      body,
      data,
      // Para iOS: especificar sonido personalizado
      _displayInForeground: true,
    };
    
    const res = await axios.post(EXPO_PUSH_API, message, {
      headers: { 'Content-Type': 'application/json' }
    });
    return res.data;
  } catch (err) {
    console.error('Error sending push', err?.response?.data || err.message);
  }
}

module.exports = { sendExpoPush };
