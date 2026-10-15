const SecurityBan = require('../models/SecurityBan');
const { createScopedLogger } = require('../utils/logger');
const { logSecurityEvent } = require('./auditLogger');

const banLogger = createScopedLogger('security:ban');

/**
 * Umbral de solicitudes de código de recuperación que activan el baneo.
 * Más de 5 solicitudes en 24h por email => ban del email y de todas sus IPs relacionadas.
 */
const FORGOT_PASSWORD_MAX_ATTEMPTS = 5;
const FORGOT_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

function getClientIp(req) {
  return (
    req.ip ||
    (req.socket && req.socket.remoteAddress) ||
    (req.connection && req.connection.remoteAddress) ||
    'unknown'
  );
}

/**
 * Verifica si un identificador (IP o email) tiene un baneo activo para forgot_password.
 */
async function isBanned(identifier, type) {
  const now = new Date();
  const ban = await SecurityBan.findOne({
    identifier,
    type,
    action: 'forgot_password',
    bannedAt: { $ne: null },
    expiresAt: { $gt: now },
  }).lean();

  return !!ban;
}

/**
 * Registra un intento de solicitud de código. Actualiza expiración a 24h y
 * relaciona el identificador con el otro extremo (IP <-> email).
 * Retorna el documento actualizado (o creado).
 */
async function registerAttempt(identifier, type, relatedValue) {
  const now = new Date();
  const expiresAt = new Date(now + FORGOT_PASSWORD_TTL_MS);
  const relatedField = type === 'ip' ? 'relatedEmails' : 'relatedIps';

  const update = {
    $set: { expiresAt },
    $inc: { attempts: 1 },
    $setOnInsert: {
      createdAt: now,
      bannedAt: null,
      reason: 'forgot_password_spam',
    },
  };

  if (relatedValue) {
    update.$addToSet = { [relatedField]: relatedValue };
  }

  return SecurityBan.findOneAndUpdate(
    { identifier, type, action: 'forgot_password' },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Marca un identificador (IP o email) como baneado.
 */
async function banIdentifier(identifier, type) {
  const now = new Date();
  await SecurityBan.findOneAndUpdate(
    { identifier, type, action: 'forgot_password' },
    { $set: { bannedAt: now } },
    { upsert: true, new: true }
  );
}

/**
 * Middleware de Express para proteger endpoints de OTP contra spam.
 *
 * Reglas:
 * - forgot-password: registra intento por IP y email. Si un email supera 5 solicitudes
 *   en 24h, se banea el email y todas las IPs que hayan usado ese email.
 * - reset-password: solo verifica si la IP o el email ya están baneados; no genera
 *   ban nuevo por usar el código.
 * - El ban bloquea ambas rutas (/auth/forgot-password y /auth/reset-password).
 *
 * @param {'forgot_password' | 'reset_password'} action
 */
function otpSecurityMiddleware(action) {
  return async function otpSecurityHandler(req, res, next) {
    try {
      const ip = getClientIp(req);
      const email = String(req.body.email || '').toLowerCase().trim();
      const now = new Date();

      // 1. Verificar baneo activo por IP (bloquea ambas rutas)
      const ipBanned = await isBanned(ip, 'ip');
      if (ipBanned) {
        banLogger.warn('IP baneada: se bloquea el envío de mail de recuperación', {
          ip,
          email,
          action,
          reason: 'ip_banned',
          blockMail: true,
        });

        await logSecurityEvent({
          req,
          eventType: `${action}_request`,
          status: 'blocked',
          metadata: { banReason: 'ip_banned', identifier: ip, type: 'ip' },
        });
        return res.status(429).json({
          error:
            'Demasiadas solicitudes desde esta IP. Intente nuevamente en 24 horas.',
          code: 'IP_BANNED_OTP',
        });
      }

      // 2. Verificar baneo activo por correo (bloquea ambas rutas)
      if (email) {
        const emailBanned = await isBanned(email, 'email');
        if (emailBanned) {
          banLogger.warn('Email baneado: se bloquea el envío de mail de recuperación', {
            ip,
            email,
            action,
            reason: 'email_banned',
            blockMail: true,
          });

          await logSecurityEvent({
            req,
            eventType: `${action}_request`,
            status: 'blocked',
            metadata: { banReason: 'email_banned', identifier: email, type: 'email' },
          });
          return res.status(429).json({
            error:
              'Demasiadas solicitudes para este correo. Intente nuevamente en 24 horas.',
            code: 'EMAIL_BANNED_OTP',
          });
        }
      }

      // 3. Solo forgot-password registra intentos hacia el baneo
      if (action === 'forgot_password') {
        // Registrar intento por IP (relacionado con el email)
        const ipDoc = await registerAttempt(ip, 'ip', email);

        // Registrar intento por email (relacionado con la IP)
        if (email) {
          await registerAttempt(email, 'email', ip);
        }

        // Verificar si el email alcanzó el umbral y activar ban + IPs relacionadas
        if (email) {
          const emailDoc = await SecurityBan.findOne({
            identifier: email,
            type: 'email',
            action: 'forgot_password',
          }).lean();

          if (
            emailDoc &&
            emailDoc.attempts >= FORGOT_PASSWORD_MAX_ATTEMPTS &&
            !emailDoc.bannedAt
          ) {
            // Activar ban del email
            await banIdentifier(email, 'email');

            // Banear todas las IPs relacionadas con este email
            const relatedIps = emailDoc.relatedIps || [];
            for (const relatedIp of relatedIps) {
              await banIdentifier(relatedIp, 'ip');
            }

            banLogger.warn('Ban activado por exceso de solicitudes de recuperación: se bloquea el envío de mail', {
              ip,
              email,
              relatedIps,
              triggerAttempts: emailDoc.attempts,
              blockMail: true,
            });

            await logSecurityEvent({
              req,
              eventType: 'otp_ban_triggered',
              status: 'blocked',
              metadata: {
                bannedIdentifier: email,
                bannedType: 'email',
                relatedIpsBanned: relatedIps,
                triggerAttempts: emailDoc.attempts,
              },
            });

            return res.status(429).json({
              error:
                'Demasiadas solicitudes de código para este correo. Intente nuevamente en 24 horas.',
              code: 'EMAIL_BANNED_OTP',
            });
          }
        }

        await logSecurityEvent({
          req,
          eventType: `${action}_request`,
          status: 'allowed',
          metadata: {
            ipAttempts: ipDoc ? ipDoc.attempts : 1,
            email: email || null,
          },
        });
      } else {
        // reset-password: solo auditoría, no registra intento de ban
        await logSecurityEvent({
          req,
          eventType: `${action}_request`,
          status: 'allowed',
          metadata: {},
        });
      }

      return next();
    } catch (error) {
      // Nunca bloquear el flujo de recuperación por un fallo del middleware.
      console.error('Error en middleware de seguridad OTP:', error);
      return next();
    }
  };
}

module.exports = {
  otpSecurityMiddleware,
  isBanned,
  registerAttempt,
  banIdentifier,
  FORGOT_PASSWORD_MAX_ATTEMPTS,
  FORGOT_PASSWORD_TTL_MS,
};
