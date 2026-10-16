const User = require('../models/User');
const QrPlateReport = require('../models/QrPlateReport');
const { dispatchNotification } = require('../services/pushNotifications');

const QR_STATUSES = new Set(['active', 'paused', 'blocked']);
const PLATE_STATUSES = new Set(['active', 'damaged', 'replacement_requested']);
const REPORT_TYPES = new Set(['damaged', 'unreadable', 'lost', 'replacement', 'new_plate']);
const REPORT_STATUSES = new Set(['open', 'in_review', 'resolved', 'pending', 'in_production', 'ready_for_installation', 'installed', 'rejected']);
const PLATE_REQUEST_TYPES = new Set(['replacement', 'new_plate']);
const PLATE_REQUEST_STATUSES = new Set(['pending', 'in_production', 'ready_for_installation', 'installed', 'rejected']);
const ACTIVE_REPORT_STATUSES = ['open', 'in_review', 'pending', 'in_production', 'ready_for_installation'];

function cleanNote(value) {
  return typeof value === 'string' ? value.trim().slice(0, 500) || null : null;
}

function cleanShippingAddress(value) {
  return typeof value === 'string' ? value.trim().slice(0, 300) : '';
}

function cleanContactPhone(value) {
  return typeof value === 'string' ? value.trim().slice(0, 40) : '';
}

function isPlateRequest(report) {
  return report?.asset === 'plate' && PLATE_REQUEST_TYPES.has(report.type);
}

function normalizePlateRequestStatus(status) {
  if (status === 'open') return 'pending';
  if (status === 'in_review') return 'in_production';
  if (status === 'resolved') return 'installed';
  return PLATE_REQUEST_STATUSES.has(status) ? status : 'pending';
}

function isTerminalRequestStatus(status) {
  return ['installed', 'rejected', 'resolved'].includes(status);
}

function formatInstallationEstimate(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

const PLATE_STATUS_NOTIFICATIONS = {
  pending: {
    title: 'Solicitud de placa recibida',
    body: 'Recibimos tu solicitud y la estamos revisando.',
  },
  in_production: {
    title: 'Tu placa está en fabricación',
    body: 'Estamos fabricando tu placa. Te avisaremos cuando esté lista para instalar.',
  },
  ready_for_installation: {
    title: 'Tu placa está lista',
    body: 'Tu placa ya está lista para instalar. Pronto podrás colocarla en la entrada.',
  },
  installed: {
    title: 'Placa instalada',
    body: 'Tu placa fue marcada como instalada y ya está lista para escanear y tocar el timbre.',
  },
  rejected: {
    title: 'Solicitud de placa rechazada',
    body: 'Tu solicitud fue rechazada. Revisá el estado desde la aplicación o contactanos si necesitás ayuda.',
  },
};

function notifyPlateRequestStatus(report, status) {
  const notification = PLATE_STATUS_NOTIFICATIONS[status];
  if (!notification || !report?.user) return;
  const installationEstimate = status === 'ready_for_installation' ? formatInstallationEstimate(report.installationScheduledAt) : null;
  const body = installationEstimate
    ? `${notification.body} Fecha y horario estimado: ${installationEstimate} hs.`
    : notification.body;

  void dispatchNotification({
    userId: report.user,
    socketEvent: 'plate:request:status',
    title: notification.title,
    body,
    payload: {
      notificationId: `plate_request_status:${report._id}:${status}`,
      screen: status === 'installed' ? '/profile' : '/qr',
      params: { requestId: String(report._id), status, ...(status === 'installed' ? { setup: '1' } : {}) },
      type: 'plate_request_status',
      requestId: String(report._id),
      plateRequestStatus: status,
    },
  }).catch((error) => {
    console.error('Error enviando notificación de estado de placa:', error);
  });
}

function userSummary(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email || null,
    qrCode: user.qrCode || null,
    qrStatus: user.qrStatus || 'active',
    plateStatus: user.plateStatus || 'active',
    plateReplacementRequestedAt: user.plateReplacementRequestedAt || null,
    plateInstalledAt: user.plateInstalledAt || null,
  };
}

async function getMyAssetStatus(req, res) {
  const user = await User.findById(req.user._id).select('name qrCode qrStatus plateStatus plateReplacementRequestedAt plateInstalledAt');
  if (!user) return res.status(404).json({ error: 'No encontramos tu cuenta' });
  const reports = await QrPlateReport.find({ user: user._id, status: { $in: ACTIVE_REPORT_STATUSES } })
    .sort({ createdAt: -1 }).select('asset type status note createdAt').lean();
  return res.json({ user: userSummary(user), reports: reports.map((report) => isPlateRequest(report) ? { ...report, status: normalizePlateRequestStatus(report.status) } : report) });
}

async function createUserReport(req, res) {
  const asset = req.body?.asset;
  const type = req.body?.type;
  if (!['qr', 'plate'].includes(asset) || !REPORT_TYPES.has(type) || (asset === 'qr' && PLATE_REQUEST_TYPES.has(type))) {
    return res.status(400).json({ error: 'Reporte de QR o placa invalido' });
  }

  const user = await User.findById(req.user._id).select('qrStatus plateStatus plateReplacementRequestedAt');
  if (!user) return res.status(404).json({ error: 'No encontramos tu cuenta' });

  const shippingAddress = cleanShippingAddress(req.body?.shippingAddress);
  const contactPhone = cleanContactPhone(req.body?.contactPhone);
  if (asset === 'plate' && type === 'new_plate' && (shippingAddress.length < 8 || !/^[0-9+() .-]{7,40}$/.test(contactPhone))) {
    return res.status(400).json({ error: 'Completá tu dirección exacta y teléfono de contacto para solicitar la placa' });
  }

  const existing = await QrPlateReport.findOne({ user: user._id, asset, status: { $in: ACTIVE_REPORT_STATUSES } });
  if (existing) return res.status(409).json({ error: 'Ya existe un reporte pendiente para ese elemento', report: existing });

  const report = await QrPlateReport.create({
    user: user._id,
    asset,
    type,
    status: asset === 'plate' && PLATE_REQUEST_TYPES.has(type) ? 'pending' : 'open',
    note: cleanNote(req.body?.note),
    shippingAddress: asset === 'plate' && type === 'new_plate' ? shippingAddress : null,
    contactPhone: asset === 'plate' && type === 'new_plate' ? contactPhone : null,
    statusHistory: asset === 'plate' && PLATE_REQUEST_TYPES.has(type) ? [{ status: 'pending' }] : [],
  });
  if (asset === 'qr' && ['damaged', 'unreadable', 'lost'].includes(type)) user.qrStatus = 'paused';
  if (asset === 'plate') user.plateStatus = PLATE_REQUEST_TYPES.has(type) ? 'replacement_requested' : 'damaged';
  if (asset === 'plate' && PLATE_REQUEST_TYPES.has(type)) user.plateReplacementRequestedAt = new Date();
  await user.save();
  return res.status(201).json({ report, user: userSummary(user) });
}

async function updateMyQrStatus(req, res) {
  const status = req.body?.status;
  if (!['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'Estado de QR invalido' });
  }

  const user = await User.findOneAndUpdate(
    { _id: req.user._id, qrStatus: { $ne: 'blocked' } },
    { qrStatus: status },
    { new: true },
  ).select('name email qrCode qrStatus plateStatus plateReplacementRequestedAt');

  if (!user) {
    const current = await User.findById(req.user._id).select('qrStatus');
    if (current?.qrStatus === 'blocked') {
      return res.status(403).json({ error: 'Este QR está bloqueado por un administrador' });
    }
    return res.status(404).json({ error: 'No encontramos tu cuenta' });
  }

  return res.json({ user: userSummary(user) });
}

async function updateVisitorSettings(req, res) {
  const configurationComplete = req.body?.configurationComplete === true;
  const visitorStatus = req.body?.visitorStatus;
  const welcomeMessage = typeof req.body?.visitorWelcomeMessage === 'string'
    ? req.body.visitorWelcomeMessage.trim().slice(0, 240)
    : undefined;
  const displayName = typeof req.body?.visitorDisplayName === 'string'
    ? req.body.visitorDisplayName.trim().slice(0, 80)
    : undefined;
  const schedule = req.body?.visitorSchedule;
  if (visitorStatus !== undefined && !['available', 'off_hours', 'unavailable'].includes(visitorStatus)) {
    return res.status(400).json({ error: 'Estado de atención invalido' });
  }
  if (welcomeMessage !== undefined && !welcomeMessage) {
    return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
  }
  if (displayName !== undefined && !displayName) {
    return res.status(400).json({ error: 'El nombre del timbre no puede estar vacío' });
  }
  if (schedule !== undefined && (!Array.isArray(schedule) || schedule.length !== 7 || schedule.some((item, index) => item?.day !== index || typeof item.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.end)))) {
    return res.status(400).json({ error: 'Los horarios no tienen un formato válido' });
  }
  const update = {};
  if (visitorStatus !== undefined) update.visitorStatus = visitorStatus;
  if (welcomeMessage !== undefined) update.visitorWelcomeMessage = welcomeMessage;
  if (displayName !== undefined) update.visitorDisplayName = displayName;
  if (schedule !== undefined) update.visitorSchedule = schedule.map((item) => ({ day: item.day, enabled: item.enabled, start: item.start, end: item.end }));
  update.visitorSettingsConfigured = configurationComplete;
  const user = await User.findByIdAndUpdate(req.user._id, update, { new: true })
    .select('name visitorDisplayName visitorWelcomeMessage visitorStatus visitorSchedule visitorSettingsConfigured');
  if (!user) return res.status(404).json({ error: 'No encontramos tu cuenta' });
  return res.json({ visitorDisplayName: user.visitorDisplayName, visitorWelcomeMessage: user.visitorWelcomeMessage, visitorStatus: user.visitorStatus, visitorSchedule: user.visitorSchedule, visitorSettingsConfigured: user.visitorSettingsConfigured });
}

async function listReports(req, res) {
  const reports = await QrPlateReport.find().populate('user', 'name email qrCode qrStatus plateStatus')
    .sort({ createdAt: -1 }).limit(200).lean();
  return res.json({ reports });
}

function plateRequestUserUpdate(status, requestedAt) {
  const normalizedStatus = normalizePlateRequestStatus(status);

  if (normalizedStatus === 'installed') {
    return { plateStatus: 'active', plateReplacementRequestedAt: null, plateInstalledAt: new Date() };
  }

  if (normalizedStatus === 'rejected') {
    return { plateStatus: 'damaged', plateReplacementRequestedAt: null };
  }

  return {
    plateStatus: 'replacement_requested',
    plateReplacementRequestedAt: requestedAt || new Date(),
  };
}

async function syncPlateRequestUser(report, status) {
  if (!isPlateRequest(report)) return null;

  return User.findByIdAndUpdate(
    report.user,
    plateRequestUserUpdate(status, report.createdAt),
    { new: true },
  ).select('name email qrCode qrStatus plateStatus plateReplacementRequestedAt plateInstalledAt');
}

async function listPlateRequests(req, res) {
  const status = String(req.query.status || '').trim();
  const filter = { asset: 'plate', type: { $in: [...PLATE_REQUEST_TYPES] } };
  if (req.user?.role === 'technician') filter.status = { $in: ['ready_for_installation', 'installed'] };

  if (status && PLATE_REQUEST_STATUSES.has(status)) {
    const legacyStatuses = status === 'pending'
      ? ['pending', 'open']
      : status === 'in_production'
        ? ['in_production', 'in_review']
        : status === 'installed'
          ? ['installed', 'resolved']
          : [status];
    filter.status = { $in: legacyStatuses };
  }
  if (req.user?.role === 'technician') filter.status = { $in: ['ready_for_installation', 'installed'] };

  const requests = await QrPlateReport.find(filter)
    .populate('user', 'name email qrCode qrStatus plateStatus plateReplacementRequestedAt plateInstalledAt')
    .populate('assignedTechnician', 'name email')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return res.json({ requests: requests.map((request) => ({ ...request, type: 'new_plate', status: normalizePlateRequestStatus(request.status), statusHistory: normalizeStatusHistory(request) })) });
}

function normalizeStatusHistory(report) {
  const history = Array.isArray(report?.statusHistory) && report.statusHistory.length
    ? report.statusHistory
    : [{ status: report?.status, changedAt: report?.createdAt }];
  return history.map((entry) => ({ status: normalizePlateRequestStatus(entry.status), changedAt: entry.changedAt || report.createdAt }));
}

async function updateReport(req, res) {
  const status = req.body?.status;
  if (!REPORT_STATUSES.has(status)) return res.status(400).json({ error: 'Estado de reporte invalido' });
  const report = await QrPlateReport.findById(req.params.reportId);
  if (!report) return res.status(404).json({ error: 'No encontramos ese reporte' });
  const previousStatus = isPlateRequest(report) ? normalizePlateRequestStatus(report.status) : report.status;
  report.status = status;
  if (isPlateRequest(report) && previousStatus !== normalizePlateRequestStatus(status)) report.statusHistory.push({ status, changedAt: new Date() });
  report.resolvedAt = isTerminalRequestStatus(status) ? new Date() : null;
  await report.save();
  await syncPlateRequestUser(report, status);
  if (isPlateRequest(report) && previousStatus !== normalizePlateRequestStatus(status)) {
    notifyPlateRequestStatus(report, normalizePlateRequestStatus(status));
  }
  return res.json({ report });
}

async function updatePlateRequest(req, res) {
  const status = req.body?.status;
  if (!PLATE_REQUEST_STATUSES.has(status)) return res.status(400).json({ error: 'Estado de solicitud invalido' });

  const report = await QrPlateReport.findOne({
    _id: req.params.requestId,
    asset: 'plate',
    type: { $in: [...PLATE_REQUEST_TYPES] },
  });

  if (!report) return res.status(404).json({ error: 'No encontramos esa solicitud de placa' });

  const previousStatus = normalizePlateRequestStatus(report.status);
  if (status === 'ready_for_installation') {
    const scheduledAt = new Date(req.body?.installationScheduledAt);
    if (!req.body?.installationScheduledAt || Number.isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ error: 'Indicá una fecha y horario estimados para la instalación' });
    }
    report.installationScheduledAt = scheduledAt;
  } else if (['pending', 'in_production', 'rejected'].includes(status)) {
    report.installationScheduledAt = null;
    report.assignedTechnician = null;
    report.technicianAssignedAt = null;
  }
  report.status = status;
  if (previousStatus !== status) report.statusHistory.push({ status, changedAt: new Date() });
  report.resolvedAt = isTerminalRequestStatus(status) ? new Date() : null;
  await report.save();
  const user = await syncPlateRequestUser(report, status);
  if (previousStatus !== status) {
    notifyPlateRequestStatus(report, status);
  }
  const request = await QrPlateReport.findById(report._id)
    .populate('user', 'name email qrCode qrStatus plateStatus plateReplacementRequestedAt plateInstalledAt')
    .populate('assignedTechnician', 'name email')
    .lean();

  return res.json({ request: { ...request, type: 'new_plate', status: normalizePlateRequestStatus(request.status), statusHistory: normalizeStatusHistory(request) }, user: user ? userSummary(user) : null });
}

async function claimPlateRequest(req, res) {
  const report = await QrPlateReport.findOne({
    _id: req.params.requestId,
    asset: 'plate',
    type: { $in: [...PLATE_REQUEST_TYPES] },
    status: 'ready_for_installation',
  });
  if (!report) return res.status(404).json({ error: 'No encontramos una instalación lista para tomar' });
  if (report.assignedTechnician && String(report.assignedTechnician) !== String(req.user._id)) {
    return res.status(409).json({ error: 'Esta instalación ya fue tomada por otro técnico' });
  }
  report.assignedTechnician = req.user._id;
  report.technicianAssignedAt = new Date();
  await report.save();
  const request = await QrPlateReport.findById(report._id)
    .populate('user', 'name email qrCode qrStatus plateStatus plateReplacementRequestedAt plateInstalledAt')
    .populate('assignedTechnician', 'name email')
    .lean();
  return res.json({ request: { ...request, type: 'new_plate', status: normalizePlateRequestStatus(request.status), statusHistory: normalizeStatusHistory(request) } });
}

async function updateUserAssetStatus(req, res) {
  const asset = req.params.asset;
  const status = req.body?.status;
  const valid = asset === 'qr' ? QR_STATUSES : asset === 'plate' ? PLATE_STATUSES : null;
  if (!valid || !valid.has(status)) return res.status(400).json({ error: 'Estado de QR o placa invalido' });
  const update = asset === 'qr' ? { qrStatus: status } : { plateStatus: status };
  if (asset === 'plate' && status === 'replacement_requested') update.plateReplacementRequestedAt = new Date();
  const user = await User.findOneAndUpdate({ _id: req.params.userId, role: 'host' }, update, { new: true })
    .select('name email qrCode qrStatus plateStatus plateReplacementRequestedAt');
  if (!user) return res.status(404).json({ error: 'No encontramos ese usuario' });
  return res.json({ user: userSummary(user) });
}

module.exports = {
  getMyAssetStatus,
  updateMyQrStatus,
  updateVisitorSettings,
  createUserReport,
  listReports,
  listPlateRequests,
  updateReport,
  updatePlateRequest,
  claimPlateRequest,
  updateUserAssetStatus,
};
