const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const User = require('../models/User');
const { sendExpoPush } = require('../services/notifications');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Register Host
 */
exports.registerHost = async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email ya registrado' });

    const hashed = await bcrypt.hash(password, 10);
    const qrCode = uuidv4();

    const host = await User.create({
      name,
      email,
      password: hashed,
      role: 'host',
      qrCode
    });

    // ✅ MODIFICADO: Generar URL web en lugar de deep link
    const qrUrl = `https://videoporteroqr-back.onrender.com/qr-landing.html?code=${qrCode}`;
    const dataUrl = await QRCode.toDataURL(qrUrl);
    host.qrDataUrl = dataUrl;
    await host.save();

    // ✅ GENERAR TOKEN para el nuevo host
    const token = jwt.sign({ id: host._id, role: host.role }, JWT_SECRET, { 
      expiresIn: '7d' 
    });

    // ✅ Devolver token y host data
    return res.json({ 
      token,
      host: { 
        id: host._id, 
        name: host.name, 
        email: host.email,
        role: host.role,
        qrCode: host.qrCode, 
        qrDataUrl: host.qrDataUrl 
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error en registro' });
  }
};

/**
 * Register Guest (via QR)
 */
exports.registerGuest = async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'Code requerido' });

  const { name, email, password } = req.body;
  try {
    const host = await User.findOne({ qrCode: code });
    if (!host) return res.status(404).json({ error: 'Host no encontrado para ese código' });

    // If email already exists, optionally link to host (or error depending on rules)
    let existing = null;
    if (email) existing = await User.findOne({ email });

    if (existing) {
      // If exists and is guest, maybe update hostRef. For simplicity, return error.
      return res.status(400).json({ error: 'Email ya existe' });
    }

    const hashed = password ? await bcrypt.hash(password, 10) : null;
    const guest = await User.create({
      name,
      email,
      password: hashed,
      role: 'guest',
      hostRef: host._id
    });

    // Notify host via push if host has pushToken
    if (host.pushToken) {
      await sendExpoPush(host.pushToken, 'Nuevo Guest', `${guest.name} ha entrado a tu sala`, { guestId: guest._id.toString() });
    }

    return res.json({ guest });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error al registrar guest' });
  }
};

/**
 * Login (all roles)
 */
exports.login = async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Usuario no encontrado' });

    if (!user.password) return res.status(400).json({ error: 'Usuario sin contraseña (registro social?)' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Contraseña incorrecta' });

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: user._id, name: user.name, role: user.role, hostRef: user.hostRef || null }});
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error en login' });
  }
};

/**
 * Get current user (MEJORADO para popular hostRef)
 */
exports.getMe = async (req, res) => {
  try {
    // Populate hostRef para obtener name y email del host
    const user = await User.findById(req.user._id)
      .populate('hostRef', 'name email') // ✅ ESTA ES LA CLAVE
      .select('-password');

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    return res.json({ 
      id: user._id, 
      name: user.name, 
      email: user.email, 
      role: user.role, 
      hostRef: user.hostRef, // ✅ Ahora será un objeto con name y email
      qrCode: user.qrCode,
      qrDataUrl: user.qrDataUrl
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error obteniendo datos del usuario' });
  }
};

/**
 * Register push token
 */
exports.registerPushToken = async (req, res) => {
  try {
    const { pushToken } = req.body;
    
    await User.findByIdAndUpdate(req.user._id, {
      pushToken: pushToken
    });

    res.json({ success: true, message: 'Push token registrado' });
  } catch (error) {
    console.error('Error registrando push token:', error);
    res.status(500).json({ error: 'Error registrando token' });
  }
};

/**
 * Save push token
 */
exports.savePushToken = async (req, res) => {
  try {
    const { pushToken } = req.body;
    req.user.pushToken = pushToken;
    await req.user.save();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error guardando push token' });
  }
};

/**
 * Join existing guest to host via QR code
 */
exports.joinHost = async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'Code requerido' });

  try {
    const host = await User.findOne({ qrCode: code });
    if (!host) return res.status(404).json({ error: 'Host no encontrado' });

    const guest = req.user;

    // Verificar si el guest ya está en este host
    if (guest.hostRef && guest.hostRef.toString() === host._id.toString()) {
      return res.status(400).json({ error: 'Ya estás en esta sala' });
    }

    // Verificar si el guest ya está en otro host
    if (guest.hostRef) {
      return res.status(400).json({ error: 'Ya estás en otra sala. Debes salir primero.' });
    }

    // Unir guest al host
    guest.hostRef = host._id;
    await guest.save();

    return res.json({ 
      message: `Te has unido a la sala de ${host.name}`,
      host: { id: host._id, name: host.name },
      guest: { id: guest._id, name: guest.name }
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error al unirse al host' });
  }
};

/**
 * Leave current host
 */
exports.leaveHost = async (req, res) => {
  try {
    const guest = req.user;
    
    if (!guest.hostRef) {
      return res.status(400).json({ error: 'No estás en ninguna sala' });
    }

    guest.hostRef = null;
    await guest.save();

    return res.json({ message: 'Has salido de la sala' });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error al salir de la sala' });
  }
};