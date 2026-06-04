
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
  password: { type: String },
  role: { type: String, enum: ['admin', 'host'], default: 'host' },
  qrCode: { type: String, unique: true, sparse: true },
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
