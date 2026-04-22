
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
    hostRef: getPrimaryHostRef(user.hostRefs || []),
    hostRefs: normalizeHostLinks(user.hostRefs || []),
    guests: normalizeGuestLinks(user.guests || []),
    qrCode: user.qrCode || null,
  };
}

function buildHostQrUrl(qrCode) {
  const baseUrl = (APP_PUBLIC_URL || ANON_WEB_APP_URL).replace(/\/$/, '');
  return `${baseUrl}/scan?code=${encodeURIComponent(qrCode)}`;
}

function normalizeGuestLinks(guests = []) {
  return guests.map((entry) => ({
    id: entry.guestId?._id || entry.guestId || null,
    name: entry.name || entry.guestId?.name || '',
    email: entry.guestId?.email || null,
    linkedAt: entry.linkedAt || null,
  }));
}

function normalizeHostLinks(hostRefs = []) {
  return hostRefs.map((entry) => ({
    id: entry.hostId?._id || entry.hostId || null,
    name: entry.name || entry.hostId?.name || '',
    email: entry.hostId?.email || null,
    linkedAt: entry.linkedAt || null,
  }));
}

function getPrimaryHostRef(hostRefs = []) {
  const first = hostRefs[0];
  return first?.hostId?._id || first?.hostId || null;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function pushUniqueLink(list, key, value, name) {
  const exists = list.some((entry) => entry?.[key]?.toString?.() === value.toString());
  if (!exists) {
    list.push({
      [key]: value,
      name,
      linkedAt: new Date(),
    });
  }
}

function filterLinkList(list, key, value) {
  return list.filter((entry) => entry?.[key]?.toString?.() !== value.toString());
}

async function registerHost(req, res) {
  const { name, password } = req.body;
  const email = validateEmail(req.body.email);
  const cleanName = validateName(name);
  const cleanPassword = validatePassword(password);

  try {
    console.log('[auth:register] request recibida:', {
      email,
      name: cleanName,
      role: req.body.role || 'host',
    });

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
    console.log('[auth:login] request recibida:', {
      email,
    });

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
        hostRef: getPrimaryHostRef(user.hostRefs || []),
        hostRefs: normalizeHostLinks(user.hostRefs || []),
        guests: normalizeGuestLinks(user.guests || []),
        role: user.role === 'admin' ? 'admin' : 'host',
      },
    });
  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ error: 'Error en login' });
  }
}

async function getMe(req, res) {
  try {
    const user = await User.findById(req.user._id)
      .populate('hostRefs.hostId', 'name email')
      .populate('guests.guestId', 'name email')
      .select('-password');

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

async function joinHost(req, res) {
  const code = validateQrCode(req.query.code || req.body.code);
  if (!code) return res.status(400).json({ error: 'Code requerido' });

  try {
    const host = await User.findOne({ qrCode: code, role: 'host' });
    if (!host) return res.status(404).json({ error: 'Host no encontrado' });

    const guest = req.user;

    if (guest._id.toString() === host._id.toString()) {
      return res.status(400).json({ error: 'No puedes vincularte a tu propio host' });
    }

    guest.hostRefs = ensureArray(guest.hostRefs);
    host.guests = ensureArray(host.guests);

    const guestLinkedToHost = guest.hostRefs.some(
      (entry) => entry?.hostId?.toString?.() === host._id.toString(),
    );
    const hostLinkedToGuest = host.guests.some(
      (entry) => entry?.guestId?.toString?.() === guest._id.toString(),
    );

    pushUniqueLink(guest.hostRefs, 'hostId', host._id, host.name);
    pushUniqueLink(host.guests, 'guestId', guest._id, guest.name);

    await Promise.all([guest.save(), host.save()]);

    return res.json({
      guest: {
        id: guest._id,
        name: guest.name,
        hostRefs: normalizeHostLinks(guest.hostRefs),
        guests: normalizeGuestLinks(guest.guests),
      },
      host: {
        id: host._id,
        name: host.name,
        guests: normalizeGuestLinks(host.guests),
      },
      alreadyLinked: guestLinkedToHost && hostLinkedToGuest,
      message: `Te has unido a la sala de ${host.name}`,
    });
  } catch (error) {
    console.error('Error al unirse al host:', error);
    return res.status(500).json({ error: 'Error al unirse al host' });
  }
}

async function leaveHost(req, res) {
  try {
    const guest = req.user;

    guest.hostRefs = ensureArray(guest.hostRefs);

    const code = validateQrCode(req.query.code || req.body.code);
    const hostId = req.query.hostId || req.body.hostId;
    let targetHost = null;

    if (code) {
      targetHost = await User.findOne({ qrCode: code, role: 'host' });
    } else if (hostId) {
      targetHost = await User.findById(hostId);
    } else if (guest.hostRefs.length === 1) {
      targetHost = await User.findById(guest.hostRefs[0].hostId);
    }

    if (!targetHost) {
      return res.status(400).json({ error: 'Host requerido para salir de la relación' });
    }

    guest.hostRefs = filterLinkList(guest.hostRefs, 'hostId', targetHost._id);

    targetHost.guests = ensureArray(targetHost.guests);
    targetHost.guests = filterLinkList(targetHost.guests, 'guestId', guest._id);

    await Promise.all([guest.save(), targetHost.save()]);

    return res.json({
      message: 'Has salido de la relación',
      guest: {
        id: guest._id,
        name: guest.name,
        hostRefs: normalizeHostLinks(guest.hostRefs),
      },
    });
  } catch (error) {
    console.error('Error al salir de la sala:', error);
    return res.status(500).json({ error: 'Error al salir de la sala' });
  }
}

module.exports = {
  registerHost,
  login,
  getMe,
  getHostByQr,
  joinHost,
  getMyQr,
  leaveHost,
};
