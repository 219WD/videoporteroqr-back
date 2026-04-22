
const { randomUUID } = require('crypto');
const PushToken = require('../models/PushToken');
const { getIO } = require('../websocket-server');

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK_SIZE = 100;

function toObjectIdString(value) {
  return value ? value.toString() : null;
}

function normalizeToken(token) {
  return typeof token === 'string' ? token.trim() : '';
}

function chunkArray(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

async function upsertPushToken({
  expoPushToken,
  userId = null,
  deviceId = null,
  platform = 'unknown',
  expoProjectId = null,
  appVersion = null,
  metadata = {},
  enabled = true,
}) {
  const token = normalizeToken(expoPushToken);

  if (!token) {
    throw new Error('Push token requerido');
  }

  const now = new Date();
  const user = userId ? toObjectIdString(userId) : null;

  return PushToken.findOneAndUpdate(
    { token },
    {
      $set: {
        token,
        user,
        deviceId: deviceId || null,
        platform: platform || 'unknown',
        expoProjectId: expoProjectId || null,
        appVersion: appVersion || null,
        metadata: metadata || {},
        enabled: enabled !== false,
        lastSeenAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    {
      new: true,
      upsert: true,
    },
  );
}

async function listPushTokensForUser(userId) {
  if (!userId) {
    return [];
  }

  return PushToken.find({
    enabled: true,
    user: toObjectIdString(userId),
  }).lean();
}

async function listAllEnabledPushTokens() {
  return PushToken.find({
    enabled: true,
  }).lean();
}

async function clearPushTokenAssociation(expoPushToken) {
  const token = normalizeToken(expoPushToken);

  if (!token) {
    throw new Error('Push token requerido');
  }

  return PushToken.findOneAndUpdate(
    { token },
    {
      $set: {
        user: null,
        enabled: true,
        lastSeenAt: new Date(),
      },
    },
    {
      new: true,
    },
  );
}

function buildExpoMessage({ token, title, body, data = {}, sound = 'default', categoryId = null }) {
  return {
    to: token,
    title,
    body,
    data,
    sound,
    categoryId,
  };
}

async function sendExpoPushMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const results = [];
  const chunks = chunkArray(messages, EXPO_CHUNK_SIZE);

  for (const chunk of chunks) {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chunk),
    });

    const payload = await response.json().catch(() => ({}));
    results.push({
      ok: response.ok,
      status: response.status,
      payload,
      count: chunk.length,
    });
  }

  return results;
}

async function sendPushNotificationToUser({
  userId,
  title,
  body,
  data = {},
  sound = 'default',
  categoryId = null,
}) {
  const tokens = await listPushTokensForUser(userId);

  if (!tokens.length) {
    return {
      delivered: false,
      reason: 'no_tokens',
      tokenCount: 0,
      results: [],
    };
  }

  const messages = tokens.map((item) =>
    buildExpoMessage({
      token: item.token,
      title,
      body,
      data,
      sound,
      categoryId,
    }),
  );

  const results = await sendExpoPushMessages(messages);

  return {
    delivered: true,
    tokenCount: tokens.length,
    results,
  };
}

async function sendPushNotificationToAll({
  title,
  body,
  data = {},
  sound = 'default',
  categoryId = null,
}) {
  const tokens = await listAllEnabledPushTokens();

  if (!tokens.length) {
    return {
      delivered: false,
      reason: 'no_tokens',
      tokenCount: 0,
      results: [],
    };
  }

  const messages = tokens.map((item) =>
    buildExpoMessage({
      token: item.token,
      title,
      body,
      data,
      sound,
      categoryId,
    }),
  );

  const results = await sendExpoPushMessages(messages);

  return {
    delivered: true,
    tokenCount: tokens.length,
    results,
  };
}

async function dispatchNotification({
  userId,
  socketEvent = 'notification:incoming',
  payload = {},
  title,
  body,
  data = {},
  sound = 'default',
  categoryId = null,
  sendPush = true,
  sendSocket = true,
}) {
  const notificationId = payload.notificationId || randomUUID();
  const notificationPayload = {
    notificationId,
    title: title || payload.title || 'Nueva notificación',
    body: body || payload.body || '',
    data: {
      ...data,
      ...(payload.data || {}),
      notificationId,
    },
    ...payload,
    notificationId,
  };

  const socketDelivered = Boolean(sendSocket);

  if (sendSocket) {
    try {
      const io = getIO();
      if (userId) {
        io.to(`user-${toObjectIdString(userId)}`).emit(socketEvent, notificationPayload);
      } else {
        io.emit(socketEvent, notificationPayload);
      }
    } catch (error) {
      console.error('[push:socket] no se pudo emitir por socket:', error);
    }
  }

  let pushResult = {
    delivered: false,
    reason: 'disabled',
    tokenCount: 0,
    results: [],
  };

  if (sendPush) {
    pushResult = userId
      ? await sendPushNotificationToUser({
        userId,
        title: notificationPayload.title,
        body: notificationPayload.body,
        data: notificationPayload.data,
        sound,
        categoryId,
      })
      : await sendPushNotificationToAll({
        title: notificationPayload.title,
        body: notificationPayload.body,
        data: notificationPayload.data,
        sound,
        categoryId,
      });
  }

  return {
    notificationId,
    socketDelivered,
    pushResult,
    payload: notificationPayload,
  };
}

module.exports = {
  clearPushTokenAssociation,
  dispatchNotification,
  listPushTokensForUser,
  listAllEnabledPushTokens,
  sendExpoPushMessages,
  sendPushNotificationToUser,
  sendPushNotificationToAll,
  upsertPushToken,
};
