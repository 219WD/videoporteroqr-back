
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
  password: { type: String },
  role: { type: String, enum: ['admin', 'plate_manager', 'technician', 'host'], default: 'host' },
  qrCode: { type: String, unique: true, sparse: true },
  qrStatus: { type: String, enum: ['active', 'paused', 'blocked'], default: 'active', index: true },
  plateStatus: { type: String, enum: ['active', 'damaged', 'replacement_requested'], default: 'active', index: true },
  plateReplacementRequestedAt: { type: Date, default: null },
  plateInstalledAt: { type: Date, default: null },
  visitorSettingsConfigured: { type: Boolean, default: false },
  visitorWelcomeMessage: { type: String, trim: true, maxlength: 240, default: 'Escribí tu mensaje y te responderemos pronto.' },
  visitorDisplayName: { type: String, trim: true, maxlength: 80, default: null },
  visitorStatus: { type: String, enum: ['available', 'off_hours', 'unavailable'], default: 'available', index: true },
  visitorSchedule: {
    type: [{ day: { type: Number, min: 0, max: 6 }, enabled: { type: Boolean, default: false }, start: { type: String, default: '09:00' }, end: { type: String, default: '18:00' } }],
    default: () => Array.from({ length: 7 }, (_, day) => ({ day, enabled: day > 0 && day < 6, start: '09:00', end: '18:00' })),
  },
  emailVerified: { type: Boolean, default: true },
  emailVerifiedAt: { type: Date, default: null },
  emailOtpHash: { type: String, default: null },
  emailOtpExpiresAt: { type: Date, default: null },
  emailOtpAttempts: { type: Number, default: 0 },
  emailOtpLastSentAt: { type: Date, default: null },
  passwordResetTokenHash: { type: String, default: null },
  passwordResetExpiresAt: { type: Date, default: null },
  passwordResetRequestedAt: { type: Date, default: null },
  passwordResetAttempts: { type: Number, default: 0 },
  tokenVersion: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
