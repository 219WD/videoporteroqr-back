const mongoose = require('mongoose');

/**
 * Registro de baneo temporal para prevenir spam de OTP (recuperación de contraseña).
 * MongoDB borra automáticamente el documento cuando se alcanza `expiresAt` (TTL index, 24h).
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
    enum: ['request_otp', 'verify_otp'],
    required: true,
  }, // 'request_otp' = pedir código, 'verify_otp' = usar código
  attempts: {
    type: Number,
    default: 1,
  },
  reason: {
    type: String,
    default: 'otp_spam',
  },
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
  bannedAt: {
    type: Date,
    default: null,
  },
});

SecurityBanSchema.index({ identifier: 1, type: 1, action: 1 });

module.exports = mongoose.model('SecurityBan', SecurityBanSchema);
