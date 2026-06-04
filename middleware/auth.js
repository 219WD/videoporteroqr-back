const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET } = require('../config/env');

function extractBearerToken(header) {
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;

  return token;
}

async function authMiddleware(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: 'Necesitas iniciar sesion de nuevo.' });
  }

  try {
    const data = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(data.id);

    if (!user) {
      return res.status(401).json({ error: 'No pudimos validar tu acceso. Inicia sesion de nuevo.' });
    }

    const tokenVersion = Number.isFinite(Number(data.ver)) ? Number(data.ver) : 0;
    const currentVersion = Number.isFinite(Number(user.tokenVersion)) ? Number(user.tokenVersion) : 0;

    if (tokenVersion !== currentVersion) {
      return res.status(401).json({ error: 'Tu sesion caduco. Inicia sesion de nuevo.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'No pudimos validar tu acceso. Inicia sesion de nuevo.' });
  }
}

function roleGuard(...allowed) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Autenticacion requerida' });
    }

    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    return next();
  };
}

module.exports = {
  authMiddleware,
  roleGuard,
};
