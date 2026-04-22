
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const QR_CODE_REGEX = /^[a-zA-Z0-9_-]{6,128}$/;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isNonEmptyString(value, maxLength = 5000) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validateEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized && EMAIL_REGEX.test(normalized) ? normalized : null;
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128 ? password : null;
}

function validateName(name, maxLength = 120) {
  return isNonEmptyString(name, maxLength) ? name.trim() : null;
}

function validateQrCode(code) {
  return typeof code === 'string' && QR_CODE_REGEX.test(code.trim()) ? code.trim() : null;
}

function validateMessage(message, maxLength = 2000) {
  return isNonEmptyString(message, maxLength) ? message.trim() : null;
}

function parsePositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function validateHostId(hostId) {
  return isNonEmptyString(String(hostId || ''), 200) ? String(hostId).trim() : null;
}

module.exports = {
  normalizeEmail,
  isNonEmptyString,
  validateEmail,
  validatePassword,
  validateName,
  validateQrCode,
  validateMessage,
  parsePositiveInt,
  validateHostId,
}