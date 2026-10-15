const mongoose = require('mongoose');

/**
 * Registro de auditoría para peticiones de recuperación de contraseña.
 * Almacena metadata completa de quien accede a /auth/forgot-password y
 * /auth/reset-password para revisar ataques desde la DB.
 */
const AuditLogSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    index: true,
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    index: true,
  },
  userAgent: {
    type: String,
  },
  method: {
    type: String,
    required: true,
  },
  path: {
    type: String,
    required: true,
  },
  eventType: {
    type: String,
    required: true,
    index: true,
  }, // 'forgot_password_request', 'reset_password_attempt', 'ban_triggered'
  status: {
    type: String,
    required: true,
    index: true,
  }, // 'allowed', 'blocked', 'rate_limited'
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  }, // JSON flexible con headers, body sanitizado, etc.
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

module.exports = mongoose.model('AuditLog', AuditLogSchema);
