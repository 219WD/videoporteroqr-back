const AuditLog = require('../models/AuditLog');

/**
 * Campos sensibles que se redactan antes de guardar en auditoría.
 */
const SENSITIVE_FIELDS = [
  'password',
  'newPassword',
  'confirmPassword',
  'otp',
  'turnstileToken',
];

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return {};
  const sanitized = { ...body };
  SENSITIVE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(sanitized, field)) {
      sanitized[field] = '[REDACTED]';
    }
  });
  return sanitized;
}

/**
 * Escribe un evento de auditoría en MongoDB. Nunca bloquea el flujo principal
 * si la escritura falla.
 */
async function logSecurityEvent({ req, eventType, status, metadata = {} }) {
  try {
    const email =
      req.body && typeof req.body.email === 'string'
        ? String(req.body.email).trim().toLowerCase()
        : undefined;

    await AuditLog.create({
      ip:
        req.ip ||
        (req.socket && req.socket.remoteAddress) ||
        (req.connection && req.connection.remoteAddress) ||
        'unknown',
      email,
      userAgent: req.headers['user-agent'] || null,
      method: req.method,
      path: req.originalUrl || req.url,
      eventType,
      status,
      metadata: {
        ...metadata,
        body: sanitizeBody(req.body),
        headers: {
          'user-agent': req.headers['user-agent'],
          origin: req.headers.origin,
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'x-real-ip': req.headers['x-real-ip'],
        },
      },
    });
  } catch (error) {
    console.error('Error escribiendo log de auditoría:', error);
  }
}

/**
 * Middleware de Express para auditar una ruta automáticamente.
 */
function auditMiddleware(eventType, status = 'allowed') {
  return async function auditHandler(req, res, next) {
    await logSecurityEvent({ req, eventType, status });
    return next();
  };
}

module.exports = {
  logSecurityEvent,
  auditMiddleware,
};
