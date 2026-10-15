const mongoose = require('mongoose');

/**
 * Registro de baneo temporal para prevenir spam de recuperación de contraseña por OTP.
 * MongoDB borra automáticamente el documento cuando se alcanza `expiresAt` (TTL index, 24h).
 *
 * - type 'email': guarda en `relatedIps` las IPs que han solicitado código para ese correo.
 *   Al superar el umbral, se banea el correo y todas esas IPs relacionadas.
 * - type 'ip': guarda en `relatedEmails` los correos solicitados desde esa IP.
 */
const SecurityBanSchema = new mongoose.Schema({
  identifier: {
    type: String,
    required: true,
    index: true,
  }, // dirección IP o correo electrónico
  type: {
    type: String,
    enum: ['ip', 'email'],
    required: true,
  },
  action: {
    type: String,
    enum: ['forgot_password'],
    required: true,
    default: 'forgot_password',
  },
  attempts: {
    type: Number,
    default: 1,
  },
  relatedIps: {
    type: [String],
    default: [],
  }, // IPs asociadas a este email (solo type 'email')
  relatedEmails: {
    type: [String],
    default: [],
  }, // emails asociados a esta IP (solo type 'ip')
  createdAt: {
    type: Date,
    default: Date.now,
  },
  /**
   * Fecha de expiración del baneo. MongoDB elimina el documento automáticamente
   * al pasar esta fecha gracias al índice TTL (expires: 0 = 24h).
   */
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 },
  },
  /**
   * Fecha en que se activó el baneo. Mientras sea null, no hay ban activo.
   */
  bannedAt: {
    type: Date,
    default: null,
  },
  reason: {
    type: String,
    default: 'forgot_password_spam',
  },
});

SecurityBanSchema.index({ identifier: 1, type: 1, action: 1 });

module.exports = mongoose.model('SecurityBan', SecurityBanSchema);
