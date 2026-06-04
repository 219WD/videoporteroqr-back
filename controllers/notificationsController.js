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
    throw new Error('No pudimos validar tu acceso');
  }

  const payload = jwt.verify(token, JWT_SECRET);
  const user = await User.findById(payload.id).select('_id role tokenVersion');

  if (!user) {
    throw new Error('No pudimos validar tu acceso');
  }

  const tokenVersion = Number.isFinite(Number(payload.ver)) ? Number(payload.ver) : 0;
  const currentVersion = Number.isFinite(Number(user.tokenVersion)) ? Number(user.tokenVersion) : 0;
  if (tokenVersion !== currentVersion) {
    throw new Error('No pudimos validar tu acceso');
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
      return sendError(res, 400, 'Se requiere el token del dispositivo');
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
      message: user ? 'Dispositivo vinculado a tu cuenta' : 'Dispositivo registrado sin cuenta',
      pushToken: serializePushToken(pushToken),
    });
  } catch (error) {
    if (
      error.name === 'TokenExpiredError' ||
      error.name === 'JsonWebTokenError' ||
      error.message === 'No pudimos validar tu acceso'
    ) {
      return sendError(res, 401, 'No pudimos validar tu acceso');
    }

    errorJson('[notifications:push-tokens:register:error]', error);
    return sendError(res, 500, 'No pudimos registrar el dispositivo');
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
    return sendError(res, 500, 'No pudimos obtener los dispositivos registrados');
  }
}

module.exports = {
  listPushTokens,
  registerPushToken,
};
