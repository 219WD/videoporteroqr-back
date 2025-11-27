const jwt = require('jsonwebtoken');
const User = require('../models/User');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });

  const token = header.split(' ')[1];
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(data.id);
    if (!user) return res.status(401).json({ error: 'Invalid token user' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function roleGuard(...allowed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No auth' });
    if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'No autorizado' });
    next();
  };
}

module.exports = { authMiddleware, roleGuard };
