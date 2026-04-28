const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const User = require('../models/User');
const { ANON_WEB_APP_URL, APP_PUBLIC_URL, JWT_SECRET } = require('../config/env');
const {
  validateEmail,
  validateName,
  validatePassword,
  validateQrCode,
} = require('../utils/validation');

function createToken(user) {
  return jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

function buildUserPayload(user) {
  const normalizedRole = user.role === 'admin' ? 'admin' : 'host';

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: normalizedRole,
    qrCode: user.qrCode || null,
  };
}

function buildHostQrUrl(qrCode) {
  const baseUrl = (APP_PUBLIC_URL || ANON_WEB_APP_URL).replace(/\/$/, '');
  return `${baseUrl}/scan?code=${encodeURIComponent(qrCode)}`;
}

async function registerHost(req, res) {
  const { name, password } = req.body;
  const email = validateEmail(req.body.email);
  const cleanName = validateName(name);
  const cleanPassword = validatePassword(password);

  try {
    if (!cleanName) {
      return res.status(400).json({ error: 'Nombre inválido' });
    }

    if (!email) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    if (!cleanPassword) {
      return res.status(400).json({ error: 'Contraseña inválida' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email ya registrado' });
    }

    const hashed = await bcrypt.hash(cleanPassword, 10);
    const qrCode = uuidv4();

    const host = await User.create({
      name: cleanName,
      email,
      password: hashed,
      qrCode,
      role: 'host',
    });

    return res.json({
      host: buildUserPayload(host),
      token: createToken(host),
    });
  } catch (error) {
    console.error('Error registrando host:', error);
    return res.status(500).json({ error: 'Error en registro' });
  }
}

async function getMyQr(req, res) {
  try {
    const user = await User.findById(req.user._id).select('qrCode role');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!user.qrCode) {
      return res.status(404).json({ error: 'No tienes un QR disponible' });
    }

    const qrDataUrl = await QRCode.toDataURL(buildHostQrUrl(user.qrCode));

    return res.json({
      qrCode: user.qrCode,
      qrDataUrl,
    });
  } catch (error) {
    console.error('Error generando QR dinámico:', error);
    return res.status(500).json({ error: 'Error generando QR' });
  }
}

async function login(req, res) {
  const email = validateEmail(req.body.email);
  const { password } = req.body;

  try {
    if (!email || typeof password !== 'string' || password.trim() === '') {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Usuario no encontrado' });

    if (!user.password) {
      return res.status(400).json({ error: 'Usuario sin contraseña' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Contraseña incorrecta' });

    return res.json({
      token: createToken(user),
      user: {
        id: user._id,
        name: user.name,
        role: user.role === 'admin' ? 'admin' : 'host',
        qrCode: user.qrCode || null,
      },
    });
  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ error: 'Error en login' });
  }
}

async function getMe(req, res) {
  try {
    const user = await User.findById(req.user._id).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    return res.json(buildUserPayload(user));
  } catch (error) {
    console.error('Error obteniendo datos del usuario:', error);
    return res.status(500).json({ error: 'Error obteniendo datos del usuario' });
  }
}

async function getHostByQr(req, res) {
  try {
    const qrCode = validateQrCode(req.params.qrCode);
    if (!qrCode) {
      return res.status(400).json({
        error: 'QR inválido',
        success: false,
      });
    }

    const host = await User.findOne({ qrCode, role: 'host' }).select('name email _id qrCode');

    if (!host) {
      return res.status(404).json({
        error: 'Host no encontrado',
        success: false,
      });
    }

    return res.json({
      host: {
        email: host.email,
        id: host._id,
        name: host.name,
        qrCode: host.qrCode,
      },
      success: true,
    });
  } catch (error) {
    console.error('Error obteniendo host por QR:', error);
    return res.status(500).json({
      error: 'Error obteniendo información del host',
      success: false,
    });
  }
}

module.exports = {
  registerHost,
  login,
  getMe,
  getHostByQr,
  getMyQr,
};
