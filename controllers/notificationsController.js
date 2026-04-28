const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const User = require('../models/User');
const { sendError, sendSuccess } = require('../utils/api');
const {
  listPushTokensForUser,
  upsertPushToken,
} = require('../services/pushNotifications');
const { errorJson, logJson } = require('../utils/logging');

async function resolveOptionalUser(req) {
  const header = req.headers.authorization;

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new Error('Token inválido');
  }

  const payload = jwt.verify(token, JWT_SECRET);
  const user = await User.findById(payload.id);

  if (!user) {
    throw new Error('Usuario inválido');
  }

  return user;
}

function serializePushToken(token) {
  return {
    id: token._id,
    token: token.token,
    user: token.user || null,
    deviceId: token.deviceId || null,
    platform: token.platform,
    expoProjectId: token.expoProjectId || null,
    appVersion: token.appVersion || null,
    enabled: token.enabled,
    lastSeenAt: token.lastSeenAt,
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

async function registerPushToken(req, res) {
  try {
    logJson('[notifications:push-tokens:register:start]', {
      authUserId: req.user?._id || null,
      hasTokenBody: Boolean(req.body?.expoPushToken || req.body?.token),
      platform: req.body?.platform || 'unknown',
    });

    const user = await resolveOptionalUser(req);
    const expoPushToken = req.body.expoPushToken || req.body.token;

    if (!expoPushToken || typeof expoPushToken !== 'string') {
      return sendError(res, 400, 'Expo push token requerido');
    }

    const pushToken = await upsertPushToken({
      expoPushToken,
      userId: user?._id || null,
      deviceId: req.body.deviceId || null,
      platform: req.body.platform || 'unknown',
      expoProjectId: req.body.expoProjectId || null,
      appVersion: req.body.appVersion || null,
      metadata: req.body.metadata || {},
      enabled: req.body.enabled !== false,
    });

    logJson('[notifications:push-tokens:register:done]', {
      userId: user?._id || null,
      pushTokenId: pushToken?._id || null,
      platform: pushToken?.platform || null,
    });

    return sendSuccess(res, {
      message: user ? 'Token vinculado al usuario' : 'Token registrado de forma anónima',
      pushToken: serializePushToken(pushToken),
    });
  } catch (error) {
    if (
      error.name === 'TokenExpiredError' ||
      error.name === 'JsonWebTokenError' ||
      error.message === 'Token inválido' ||
      error.message === 'Usuario inválido'
    ) {
      return sendError(res, 401, 'Token inválido');
    }

    errorJson('[notifications:push-tokens:register:error]', error);
    return sendError(res, 500, 'Error registrando push token');
  }
}

async function listPushTokens(req, res) {
  try {
    const isAdmin = req.user.role === 'admin';
    const userId = isAdmin && req.query.userId ? req.query.userId : req.user._id;
    const tokens = await listPushTokensForUser(userId);

    return sendSuccess(res, {
      tokens: tokens.map(serializePushToken),
      count: tokens.length,
    });
  } catch (error) {
    console.error('Error obteniendo push tokens:', error);
    return sendError(res, 500, 'Error obteniendo push tokens');
  }
}

module.exports = {
  listPushTokens,
  registerPushToken,
};
