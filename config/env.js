
const dotenv = require('dotenv');

dotenv.config();

function required(name, value) {
  if (!value || String(value).trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const MONGO_URI = required('MONGO_URI', process.env.MONGO_URI);
const JWT_SECRET = required('JWT_SECRET', process.env.JWT_SECRET);
const APP_PUBLIC_URL =
  process.env.APP_PUBLIC_URL || `http://localhost:${PORT}`;
const ANON_WEB_APP_URL =
  process.env.ANON_WEB_APP_URL || 'http://localhost:5173';
const EXPO_PUSH_API =
  process.env.EXPO_PUSH_API || 'https://exp.host/--/api/v2/push/send';
const defaultAllowedOrigins = [APP_PUBLIC_URL, ANON_WEB_APP_URL];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : defaultAllowedOrigins)
  .map((origin) => origin.trim())
  .filter(Boolean);
const ADMIN_NAME = process.env.ADMIN_NAME || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

module.exports = {
  PORT,
  NODE_ENV,
  MONGO_URI,
  JWT_SECRET,
  APP_PUBLIC_URL,
  ANON_WEB_APP_URL,
  EXPO_PUSH_API,
  ALLOWED_ORIGINS,
  ADMIN_NAME,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
};


