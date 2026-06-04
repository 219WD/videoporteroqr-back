const QRCode = require('qrcode');
const User = require('../models/User');
const { ANON_WEB_APP_URL, APP_PUBLIC_URL } = require('../config/env');

function buildHostQrUrl(qrCode) {
  const baseUrl = ANON_WEB_APP_URL.replace(/\/$/, '');
  return `${baseUrl}/qr/${encodeURIComponent(qrCode)}`;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRequestAbortController(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Request aborted'));
    }
  };

  req.once('aborted', abort);
  res.once('close', abort);

  return controller;
}

function formatUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email || null,
    role: user.role || 'host',
    qrCode: user.qrCode || null,
    createdAt: user.createdAt || null,
  };
}

async function getUsers(req, res) {
  const controller = createRequestAbortController(req, res);

  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 10, 100);
    const skip = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const filter = { role: 'host' };

    if (search) {
      filter.name = { $regex: escapeRegex(search), $options: 'i' };
    }

    const [total, users] = await Promise.all([
      User.countDocuments(filter).setOptions({
        signal: controller.signal,
        maxTimeMS: 5000,
      }),
      User.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .setOptions({
          signal: controller.signal,
          maxTimeMS: 5000,
        })
        .select('name email qrCode role createdAt'),
    ]);

    return res.json({
      users: users.map(formatUser),
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      return;
    }

    console.error('Error loading backoffice users:', error);
    return res.status(500).json({ error: 'No pudimos cargar los usuarios' });
  }
}

async function getUserQrPng(req, res) {
  const controller = createRequestAbortController(req, res);

  try {
    const user = await User.findById(req.params.userId).select('name qrCode');

    if (!user) {
      return res.status(404).json({ error: 'No encontramos ese usuario' });
    }

    if (!user.qrCode) {
      return res.status(404).json({ error: 'El usuario no tiene QR disponible' });
    }

    const qrBuffer = await QRCode.toBuffer(buildHostQrUrl(user.qrCode), {
      type: 'png',
      margin: 2,
      width: 512,
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
    });

    const safeName = String(user.name || 'usuario')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'usuario';

    if (controller.signal.aborted) {
      return;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-qr.png"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(qrBuffer);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      return;
    }

    console.error('Error generating QR png:', error);
    return res.status(500).json({ error: 'No pudimos generar el QR' });
  }
}

module.exports = {
  getUsers,
  getUserQrPng,
};
