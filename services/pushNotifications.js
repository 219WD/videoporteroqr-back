
const { randomUUID } = require('crypto');
const { Expo } = require('expo-server-sdk');
const PushToken = require('../models/PushToken');
const { getIO } = require('../websocket-server');
const { errorJson, logJson, warnJson } = require('../utils/logging');

const expo = new Expo();

function toObjectIdString(value) {
  return value ? value.toString() : null;
}

function normalizeToken(token) {
  return typeof token === 'string' ? token.trim() : '';
}

function safeTokenPrefix(token, length = 24) {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }

  return token.slice(0, length);
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

  logJson('[push:token:upsert:start]', {
    userId: toObjectIdString(userId),
    deviceId: deviceId || null,
    platform: platform || 'unknown',
    expoProjectId: expoProjectId || null,
    appVersion: appVersion || null,
    enabled: enabled !== false,
    tokenPrefix: safeTokenPrefix(token),
    metadataKeys: metadata && typeof metadata === 'object' ? Object.keys(metadata) : [],
  });

  if (!token) {
    warnJson('[push:token:upsert:missing-token]', {
      userId: toObjectIdString(userId),
      deviceId: deviceId || null,
      platform: platform || 'unknown',
    });
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
  ).then((savedToken) => {
    logJson('[push:token:upsert:done]', {
      tokenId: savedToken?._id || null,
      userId: savedToken?.user || null,
      deviceId: savedToken?.deviceId || null,
      platform: savedToken?.platform || null,
      expoProjectId: savedToken?.expoProjectId || null,
      enabled: savedToken?.enabled ?? null,
      lastSeenAt: savedToken?.lastSeenAt || null,
    });

    return savedToken;
  });
}

async function listPushTokensForUser(userId) {
  if (!userId) {
    warnJson('[push:tokens:list:user:missing-user]', {});
    return [];
  }

  logJson('[push:tokens:list:user:start]', {
    userId: toObjectIdString(userId),
  });

  const tokens = await PushToken.find({
    enabled: true,
    user: toObjectIdString(userId),
  }).lean();

  logJson('[push:tokens:list:user:done]', {
    userId: toObjectIdString(userId),
    tokenCount: tokens.length,
    tokenPrefixes: tokens.slice(0, 10).map((item) => safeTokenPrefix(item.token)),
  });

  return tokens;
}

async function listAllEnabledPushTokens() {
  logJson('[push:tokens:list:all:start]', {});

  const tokens = await PushToken.find({
    enabled: true,
  }).lean();

  logJson('[push:tokens:list:all:done]', {
    tokenCount: tokens.length,
    tokenPrefixes: tokens.slice(0, 10).map((item) => safeTokenPrefix(item.token)),
  });

  return tokens;
}

async function clearPushTokenAssociation(expoPushToken) {
  const token = normalizeToken(expoPushToken);

  logJson('[push:token:clear:start]', {
    tokenPrefix: safeTokenPrefix(token),
  });

  if (!token) {
    warnJson('[push:token:clear:missing-token]', {});
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
  ).then((savedToken) => {
    logJson('[push:token:clear:done]', {
      tokenId: savedToken?._id || null,
      tokenPrefix: safeTokenPrefix(savedToken?.token),
      enabled: savedToken?.enabled ?? null,
      lastSeenAt: savedToken?.lastSeenAt || null,
    });

    return savedToken;
  });
}

function buildExpoMessage({
  token,
  title,
  body,
  data = {},
}) {
  return {
    to: token,
    title,
    body,
    data,
  };
}

async function sendExpoPushMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    warnJson('[push:expo:send:skip-empty]', {});
    return [];
  }

  const results = [];
  const chunks = expo.chunkPushNotifications(messages);
  logJson('[push:expo:send:start]', {
    messageCount: messages.length,
    chunkCount: chunks.length,
    messageTokens: messages.slice(0, 10).map((item) => safeTokenPrefix(item?.to)),
  });

  for (const [chunkIndex, chunk] of chunks.entries()) {
    try {
      logJson('[push:expo:send:chunk:start]', {
        chunkIndex,
        chunkSize: chunk.length,
        tokenPrefixes: chunk.slice(0, 10).map((item) => safeTokenPrefix(item?.to)),
      });

      const tickets = await expo.sendPushNotificationsAsync(chunk);
      logJson('[push:expo:send:chunk:tickets]', {
        chunkIndex,
        ticketCount: tickets.length,
        tickets: tickets.map((ticket) => ({
          status: ticket?.status || null,
          id: ticket?.id || null,
          message: ticket?.message || null,
          details: ticket?.details || null,
        })),
      });

      const receiptIds = tickets
        .filter((ticket) => ticket?.status === 'ok' && ticket?.id)
        .map((ticket) => ticket.id);

      const receiptResults = [];
      logJson('[push:expo:send:chunk:receipt-ids]', {
        chunkIndex,
        receiptIdCount: receiptIds.length,
      });

      if (receiptIds.length > 0) {
        const receiptIdChunks = expo.chunkPushNotificationReceiptIds(receiptIds);
        logJson('[push:expo:send:chunk:receipt-chunks]', {
          chunkIndex,
          receiptChunkCount: receiptIdChunks.length,
          receiptChunkSizes: receiptIdChunks.map((receiptChunk) => receiptChunk.length),
        });

        for (const [receiptChunkIndex, receiptIdChunk] of receiptIdChunks.entries()) {
          try {
            logJson('[push:expo:send:chunk:receipt:start]', {
              chunkIndex,
              receiptChunkIndex,
              receiptCount: receiptIdChunk.length,
            });

            const receipts = await expo.getPushNotificationReceiptsAsync(receiptIdChunk);
            logJson('[push:expo:send:chunk:receipt:done]', {
              chunkIndex,
              receiptChunkIndex,
              receiptCount: receiptIdChunk.length,
              receiptIds: receiptIdChunk,
              receiptKeys: receipts ? Object.keys(receipts) : [],
            });

            receiptResults.push({
              ok: true,
              status: 200,
              count: receiptIdChunk.length,
              payload: receipts,
            });
          } catch (error) {
            errorJson('[push:expo:send:chunk:receipt:error]', {
              chunkIndex,
              receiptChunkIndex,
              receiptCount: receiptIdChunk.length,
              error,
            });
            receiptResults.push({
              ok: false,
              status: 500,
              count: receiptIdChunk.length,
              payload: {
                message: error?.message || 'Error obteniendo receipts',
              },
            });
          }
        }
      }

      const ticketErrors = tickets.filter((ticket) => ticket?.status === 'error');
      logJson('[push:expo:send:chunk:summary]', {
        chunkIndex,
        chunkSize: chunk.length,
        okTicketCount: tickets.length - ticketErrors.length,
        errorTicketCount: ticketErrors.length,
        receiptResultCount: receiptResults.length,
      });

      results.push({
        ok: ticketErrors.length === 0,
        status: 200,
        payload: {
          tickets,
          receipts: receiptResults,
        },
        count: chunk.length,
      });
    } catch (error) {
      errorJson('[push:expo:send:chunk:error]', {
        chunkIndex,
        chunkSize: chunk.length,
        error,
      });
      results.push({
        ok: false,
        status: 500,
        payload: {
          message: error?.message || 'Error enviando chunk a Expo',
        },
        count: chunk.length,
      });
    }
  }

  return results;
}

async function sendPushNotificationToUser({
  userId,
  title,
  body,
  data = {},
}) {
  const tokens = await listPushTokensForUser(userId);
  logJson('[push:delivery:user:tokens]', {
    userId: toObjectIdString(userId),
    tokenCount: tokens.length,
  });

  if (!tokens.length) {
    warnJson('[push:delivery:user:no-tokens]', {
      userId: toObjectIdString(userId),
    });
    return {
      delivered: false,
      reason: 'no_tokens',
      tokenCount: 0,
      results: [],
    };
  }

  const validTokens = tokens.filter((item) => {
    const isValid = Expo.isExpoPushToken(item.token);

    logJson('[push:delivery:user:token-check]', {
      userId: toObjectIdString(userId),
      tokenId: item._id || null,
      tokenPrefix: safeTokenPrefix(item.token),
      isValid,
    });

    if (!isValid) {
      warnJson('[push:delivery:user:invalid-token]', {
        userId: toObjectIdString(userId),
        tokenId: item._id || null,
        tokenPrefix: typeof item.token === 'string' ? item.token.slice(0, 24) : null,
      });
    }

    return isValid;
  });

  if (!validTokens.length) {
    return {
      delivered: false,
      reason: 'invalid_tokens',
      tokenCount: 0,
      results: [],
    };
  }

  const messages = validTokens.map((item) =>
    buildExpoMessage({
      token: item.token,
      title,
      body,
      data,
    }),
  );

  logJson('[push:delivery:user:messages]', {
    userId: toObjectIdString(userId),
    messageCount: messages.length,
    tokenPrefixes: messages.slice(0, 10).map((item) => safeTokenPrefix(item.to)),
    title,
    bodyLength: typeof body === 'string' ? body.length : 0,
  });

  const results = await sendExpoPushMessages(messages);

  const accepted = results.length > 0 && results.every((result) => result.ok);

  logJson('[push:delivery:user:results]', {
    userId: toObjectIdString(userId),
    tokenCount: validTokens.length,
    results: results.map((result) => ({
      ok: result.ok,
      status: result.status,
      count: result.count,
      payloadKeys: result.payload && typeof result.payload === 'object' ? Object.keys(result.payload) : [],
    })),
  });

  return {
    delivered: accepted,
    tokenCount: validTokens.length,
    results,
  };
}

async function sendPushNotificationToAll({
  title,
  body,
  data = {},
}) {
  const tokens = await listAllEnabledPushTokens();
  logJson('[push:delivery:all:tokens]', {
    tokenCount: tokens.length,
  });

  if (!tokens.length) {
    warnJson('[push:delivery:all:no-tokens]', {
    });
    return {
      delivered: false,
      reason: 'no_tokens',
      tokenCount: 0,
      results: [],
    };
  }

  const validTokens = tokens.filter((item) => Expo.isExpoPushToken(item.token));

  logJson('[push:delivery:all:valid-tokens]', {
    tokenCount: validTokens.length,
    tokenPrefixes: validTokens.slice(0, 10).map((item) => safeTokenPrefix(item.token)),
  });

  const messages = validTokens.map((item) =>
    buildExpoMessage({
      token: item.token,
      title,
      body,
      data,
    }),
  );

  logJson('[push:delivery:all:messages]', {
    messageCount: messages.length,
    tokenPrefixes: messages.slice(0, 10).map((item) => safeTokenPrefix(item.to)),
    title,
    bodyLength: typeof body === 'string' ? body.length : 0,
  });

  const results = await sendExpoPushMessages(messages);

  const accepted = results.length > 0 && results.every((result) => result.ok);

  logJson('[push:delivery:all:results]', {
    tokenCount: validTokens.length,
    results: results.map((result) => ({
      ok: result.ok,
      status: result.status,
      count: result.count,
      payloadKeys: result.payload && typeof result.payload === 'object' ? Object.keys(result.payload) : [],
    })),
  });

  return {
    delivered: accepted,
    tokenCount: validTokens.length,
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
  sendPush = true,
  sendSocket = true,
}) {
  const notificationId = payload.notificationId || randomUUID();
  logJson('[push:dispatch:start]', {
    notificationId,
    userId: toObjectIdString(userId),
    socketEvent,
    sendPush,
    sendSocket,
    title: title || payload.title || 'Nueva notificación',
  });

  logJson('[push:dispatch:payload]', {
    notificationId,
    userId: toObjectIdString(userId),
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
  });

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
      logJson('[push:dispatch:socket:emit]', {
        notificationId,
        userId: toObjectIdString(userId),
        socketEvent,
      });
      if (userId) {
        io.to(`user-${toObjectIdString(userId)}`).emit(socketEvent, notificationPayload);
      } else {
        io.emit(socketEvent, notificationPayload);
      }
    } catch (error) {
      errorJson('[push:socket:error]', error);
    }
  }

  let pushResult = {
    delivered: false,
    reason: 'disabled',
    tokenCount: 0,
    results: [],
  };

  if (sendPush) {
    logJson('[push:dispatch:push:start]', {
      notificationId,
      userId: toObjectIdString(userId),
      socketEvent,
    });
    pushResult = userId
      ? await sendPushNotificationToUser({
        userId,
        title: notificationPayload.title,
        body: notificationPayload.body,
        data: notificationPayload.data,
      })
      : await sendPushNotificationToAll({
        title: notificationPayload.title,
        body: notificationPayload.body,
        data: notificationPayload.data,
      });
  }

  if (!sendPush) {
    warnJson('[push:dispatch:push-disabled]', {
      notificationId,
      userId: toObjectIdString(userId),
      socketEvent,
    });
  }

  logJson('[push:dispatch:done]', {
    notificationId,
    userId: toObjectIdString(userId),
    socketEvent,
    socketDelivered,
    pushDelivered: pushResult.delivered || false,
    pushReason: pushResult.reason || null,
    tokenCount: pushResult.tokenCount || 0,
    pushResultStatuses: Array.isArray(pushResult.results)
      ? pushResult.results.map((result) => ({
        ok: result.ok,
        status: result.status,
        count: result.count,
      }))
      : [],
  });

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
