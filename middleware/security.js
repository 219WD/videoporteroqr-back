
const { NODE_ENV } = require('../config/env');

function buildCorsOptions(allowedOrigins) {
  const originSet = new Set(allowedOrigins || []);

  return {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      if (!origin || originSet.has(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origen no permitido por CORS'));
    },
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  if (NODE_ENV !== 'development') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
  );

  return next();
}

function createRateLimiter({
  windowMs,
  max,
  keyFn = (req) => req.ip,
  message = 'Demasiadas solicitudes, intenta mas tarde',
}) {
  const buckets = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.resetAt >= windowMs) {
        buckets.delete(key);
      }
    }
  }, windowMs).unref?.();

  return function rateLimiter(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || now - bucket.resetAt >= windowMs) {
      bucket = { count: 0, resetAt: now };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000).toString());
      return res.status(429).json({
        error: message,
        success: false,
      });
    }

    return next();
  };
}

module.exports = {
  buildCorsOptions,
  securityHeaders,
  createRateLimiter,
};