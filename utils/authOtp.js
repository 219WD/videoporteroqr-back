const { createHmac, randomInt } = require('crypto');
const { OTP_SECRET } = require('../config/env');

const EMAIL_VERIFICATION_OTP_LENGTH = 6;
const EMAIL_VERIFICATION_OTP_TTL_MS = 10 * 60 * 1000;
const PASSWORD_RESET_OTP_TTL_MS = 15 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function generateOtpCode(length = EMAIL_VERIFICATION_OTP_LENGTH) {
  const max = 10 ** length;
  return randomInt(0, max).toString().padStart(length, '0');
}

function normalizeOtpCode(code) {
  return typeof code === 'string' ? code.trim() : '';
}

function isValidOtpFormat(code, length = EMAIL_VERIFICATION_OTP_LENGTH) {
  return new RegExp(`^\\d{${length}}$`).test(normalizeOtpCode(code));
}

function hashOtpCode({ email, purpose, code }) {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedPurpose = typeof purpose === 'string' ? purpose.trim() : '';
  const normalizedCode = normalizeOtpCode(code);

  return createHmac('sha256', OTP_SECRET)
    .update(`${normalizedPurpose}:${normalizedEmail}:${normalizedCode}`)
    .digest('hex');
}

function otpExpirationDate(ttlMs) {
  return new Date(Date.now() + ttlMs);
}

function isOtpExpired(expiresAt) {
  return !expiresAt || new Date(expiresAt).getTime() <= Date.now();
}

module.exports = {
  EMAIL_VERIFICATION_OTP_LENGTH,
  EMAIL_VERIFICATION_OTP_TTL_MS,
  PASSWORD_RESET_OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  MAX_OTP_ATTEMPTS,
  generateOtpCode,
  normalizeOtpCode,
  isValidOtpFormat,
  hashOtpCode,
  otpExpirationDate,
  isOtpExpired,
};
