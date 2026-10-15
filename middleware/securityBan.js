const SecurityBan = require('../models/SecurityBan');
const { logSecurityEvent } = require('./auditLogger');

/**
 * Límite de solicitudes de recuperación de contraseña por OTP.
 * Máximo 5 peticiones en 24 horas por IP y por correo.
 * Al superarse, se registra un baneo temporal en MongoDB con TTL de 24h
 * (el documento se borra solo automáticamente).
 */
const FORGOT_PASSWORD_MAX_ATTEMPTS = 5;
const FORGOT_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Verifica si un identificador (IP o email) tiene un baneo activo para
 * solicitudes de código de recuperación (request_otp).
 */
async function isBanned(identifier, type) {
  const now = new Date();
  const ban = await SecurityBan.findOne({
    identifier,
    type,
    action: 'request_otp',
    attempts: { $gte: FORGOT_PASSWORD_MAX_ATTEMPTS },
    expiresAt: { $gt: now },
  }).lean();

  return !!ban;
}

/**
 * Registra una solicitud de código de recuperación. Establece expiración a 24h
 * para que MongoDB elimine el documento automáticamente (TTL index).
 */
async function registerAttempt(identifier, type) {
  const now = new Date();
  const expiresAt = new Date(now + FORGOT_PASSWORD_TTL_MS);

  await SecurityBan.updateOne(
    { identifier, type, action: 'request_otp' },
    {
      $set: { expiresAt },
      $inc: { attempts: 1 },
      $setOnInsert: { createdAt: now, reason: 'forgot_password_spam' },
    },
    { upsert: true }
  );
}

/**
 * Middleware de Express para proteger POST /auth/forgot-password contra spam
 * de solicitudes de código de recuperación por OTP.
 *
 * Reglas:
 * - Máximo 5 solicitudes en 24h por IP.
 * - Máximo 5 solicitudes en 24h por correo.
 * - Al superarse el límite en cualquiera de los dos, se banea con TTL de 24h
 *   y se responde 429. No hay baneo por usar el código (reset-password).
 */
async function forgotPasswordBanMiddleware(req, res, next) {
  try {
    const ip =
      req.ip ||
      (req.socket && req.socket.remoteAddress) ||
      (req.connection && req.connection.remoteAddress) ||
      'unknown';
    const email = String(req.body.email || '').toLowerCase().trim();

    // 1. Verificar baneo activo por IP
    const ipBanned = await isBanned(ip, 'ip');
    if (ipBanned) {
      await logSecurityEvent({
        req,
        eventType: 'forgot_password_request',
        status: 'blocked',
        metadata: { banReason: 'ip_banned', attempts: FORGOT_PASSWORD_MAX_ATTEMPTS },
      });
      return res.status(429).json({
        error:
          'Demasiadas solicitudes de código desde esta IP. Intente nuevamente en 24 horas.',
        code: 'IP_BANNED_FORGOT_PASSWORD',
      });
    }

    // 2. Verificar baneo activo por correo
    if (email) {
      const emailBanned = await isBanned(email, 'email');
      if (emailBanned) {
        await logSecurityEvent({
          req,
          eventType: 'forgot_password_request',
          status: 'blocked',
          metadata: { banReason: 'email_banned', attempts: FORGOT_PASSWORD_MAX_ATTEMPTS },
        });
        return res.status(429).json({
          error:
            'Demasiadas solicitudes de código para este correo. Intente nuevamente en 24 horas.',
          code: 'EMAIL_BANNED_FORGOT_PASSWORD',
        });
      }
    }

    // 3. Registrar intentos (IP y correo). Los registros expiran solos a las 24h.
    await registerAttempt(ip, 'ip');
    if (email) {
      await registerAttempt(email, 'email');
    }

    await logSecurityEvent({
      req,
      eventType: 'forgot_password_request',
      status: 'allowed',
      metadata: { attemptsRecorded: true },
    });

    return next();
  } catch (error) {
    // Nunca bloquear el flujo de recuperación por un fallo del middleware.
    console.error('Error en middleware de ban de recuperación de contraseña:', error);
    return next();
  }
}

module.exports = {
  forgotPasswordBanMiddleware,
  isBanned,
  registerAttempt,
  FORGOT_PASSWORD_MAX_ATTEMPTS,
  FORGOT_PASSWORD_TTL_MS,
};
