
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

const GUEST_TOKEN_PURPOSE = 'guest-access';

function normalizeToken(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractGuestToken(req) {
  return normalizeToken(
    req?.headers?.['x-guest-token'] ||
    req?.headers?.['x-access-token'] ||
    req?.query?.token ||
    req?.query?.guestToken ||
    req?.body?.guestToken ||
    req?.body?.accessToken,
  );
}

function signGuestToken(payload, expiresIn = '24h') {
  return jwt.sign(
    {
      ...payload,
      purpose: GUEST_TOKEN_PURPOSE,
    },
    JWT_SECRET,
    { expiresIn },
  );
}

function verifyGuestToken(token) {
  const normalized = normalizeToken(token);
  if (!normalized) {
    return null;
  }

  try {
    const payload = jwt.verify(normalized, JWT_SECRET);
    if (!payload || payload.purpose !== GUEST_TOKEN_PURPOSE) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}

function userIdToString(user) {
  return user?._id?.toString?.() || user?.id?.toString?.() || null;
}

function isUserOwnerOfHost(user, hostId) {
  const userId = userIdToString(user);
  const targetId = hostId?.toString?.() || hostId || null;
  return !!userId && !!targetId && userId === targetId;
}

function canUserAccessCall(user, call) {
  if (!user || !call) return false;

  const userId = userIdToString(user);
  const hostId = call.hostId?.toString?.() || call.hostId || null;
  const guestId = call.guestId?.toString?.() || call.guestId || null;

  return !!userId && (userId === hostId || userId === guestId);
}

function canUserAccessSession(user, session) {
  if (!user || !session) return false;

  const userId = userIdToString(user);
  const callerId = session.callerId?.toString?.() || session.callerId || null;
  const calleeId = session.calleeId?.toString?.() || session.calleeId || null;

  return !!userId && (userId === callerId || userId === calleeId);
}

module.exports = {
  canUserAccessCall,
  canUserAccessSession,
  extractGuestToken,
  isUserOwnerOfHost,
  signGuestToken,
  verifyGuestToken,
};
