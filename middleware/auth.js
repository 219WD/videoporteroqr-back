
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
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const data = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(data.id);

    if (!user) {
      return res.status(401).json({ error: 'Usuario no válido para este token' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function roleGuard(...allowed) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Autenticación requerida' });
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

