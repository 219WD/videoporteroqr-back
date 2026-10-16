const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const User = require('../models/User');
const QrPlateReport = require('../models/QrPlateReport');
const { ANON_WEB_APP_URL, APP_PUBLIC_URL, JWT_SECRET, NODEMAILER_BYPASS_ENABLED } = require('../config/env');
const { sendPasswordResetCodeEmail, sendVerificationCodeEmail } = require('../services/emailService');
const {
  EMAIL_VERIFICATION_OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  PASSWORD_RESET_OTP_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  isOtpExpired,
  isValidOtpFormat,
  normalizeOtpCode,
  otpExpirationDate,
} = require('../utils/authOtp');
const {
  validateEmail,
  validateName,
  validatePassword,
  validateQrCode,
} = require('../utils/validation');

function createToken(user, rememberMe = false) {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      ver: Number.isFinite(Number(user.tokenVersion)) ? Number(user.tokenVersion) : 0,
    },
    JWT_SECRET,
    {
      expiresIn: rememberMe ? '30d' : '7d',
    },
  );
}

function buildUserPayload(user) {
  const normalizedRole = ['admin', 'plate_manager', 'technician'].includes(user.role) ? user.role : 'host';

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: normalizedRole,
    qrCode: user.qrCode || null,
    emailVerified: user.emailVerified !== false,
  };
}

function buildHostQrUrl(qrCode) {
  const baseUrl = ANON_WEB_APP_URL.replace(/\/$/, '');
  return `${baseUrl}/qr/${encodeURIComponent(qrCode)}`;
}

function getEffectiveVisitorStatus(user) {
  const manualStatus = user.visitorStatus || 'available';
  if (manualStatus !== 'available') return manualStatus;
  const schedule = Array.isArray(user.visitorSchedule) ? user.visitorSchedule : [];
  if (schedule.length === 0) return 'available';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((part) => part.type === 'weekday')?.value || '');
  const current = `${parts.find((part) => part.type === 'hour')?.value || '00'}:${parts.find((part) => part.type === 'minute')?.value || '00'}`;
  const today = schedule.find((item) => item.day === weekday);
  return today?.enabled && current >= today.start && current <= today.end ? 'available' : 'off_hours';
}

function clearEmailOtp(user) {
  user.emailOtpHash = null;
  user.emailOtpExpiresAt = null;
  user.emailOtpAttempts = 0;
}

function clearPasswordResetOtp(user) {
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  user.passwordResetRequestedAt = null;
  user.passwordResetAttempts = 0;
}

function canResendEmailOtp(user) {
  if (!user.emailOtpLastSentAt) {
    return true;
  }

  return Date.now() - new Date(user.emailOtpLastSentAt).getTime() >= OTP_RESEND_COOLDOWN_MS;
}

function canBypassOtpValidation(otp) {
  return NODEMAILER_BYPASS_ENABLED && isValidOtpFormat(otp);
}

async function issueVerificationOtp(user) {
  const code = generateOtpCode();
  user.emailOtpHash = hashOtpCode({
    email: user.email,
    purpose: 'email-verification',
    code,
  });
  user.emailOtpExpiresAt = otpExpirationDate(EMAIL_VERIFICATION_OTP_TTL_MS);
  user.emailOtpAttempts = 0;
  user.emailOtpLastSentAt = new Date();
  await user.save();
  return code;
}

async function issuePasswordResetOtp(user) {
  const code = generateOtpCode();
  user.passwordResetTokenHash = hashOtpCode({
    email: user.email,
    purpose: 'password-reset',
    code,
  });
  user.passwordResetExpiresAt = otpExpirationDate(PASSWORD_RESET_OTP_TTL_MS);
  user.passwordResetRequestedAt = new Date();
  user.passwordResetAttempts = 0;
  await user.save();
  return code;
}

async function registerHost(req, res) {
  const { name, password, passwordConfirmation } = req.body;
  const email = validateEmail(req.body.email);
  const cleanName = validateName(name);
  const cleanPassword = validatePassword(password);

  try {
    if (!cleanName) {
      return res.status(400).json({ error: 'Escribi un nombre valido' });
    }

    if (!email) {
      return res.status(400).json({ error: 'Escribi un correo valido' });
    }

    if (!cleanPassword) {
      return res.status(400).json({ error: 'La contrasena debe tener entre 8 y 128 caracteres', code: 'INVALID_PASSWORD' });
    }

    if (password !== passwordConfirmation) {
      return res.status(400).json({ error: 'Las contrasenas no coinciden', code: 'PASSWORD_MISMATCH' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese correo' });
    }

    const hashed = await bcrypt.hash(cleanPassword, 10);
    const qrCode = uuidv4();

    const host = await User.create({
      name: cleanName,
      email,
      password: hashed,
      qrCode,
      role: 'host',
      emailVerified: false,
      emailVerifiedAt: null,
    });

    if (!NODEMAILER_BYPASS_ENABLED) {
      const otpCode = await issueVerificationOtp(host);

      try {
        await sendVerificationCodeEmail({
          to: host.email,
          name: host.name,
          code: otpCode,
        });
      } catch (emailError) {
        await User.deleteOne({ _id: host._id });
        throw emailError;
      }
    }

    return res.status(201).json({
      success: true,
      requiresEmailVerification: true,
      email: host.email,
      emailVerificationExpiresAt: host.emailOtpExpiresAt,
      emailVerificationResendAvailableAt: new Date(Date.now() + OTP_RESEND_COOLDOWN_MS),
      user: buildUserPayload(host),
      message: 'Cuenta creada. Revisa tu correo para verificarla.',
    });
  } catch (error) {
    console.error('Error registrando host:', error);
    return res.status(500).json({ error: 'No pudimos crear la cuenta' });
  }
}

async function getMyQr(req, res) {
  try {
    const user = await User.findById(req.user._id).select('name qrCode role qrStatus plateStatus plateReplacementRequestedAt plateInstalledAt visitorSettingsConfigured visitorDisplayName visitorWelcomeMessage visitorStatus visitorSchedule');

    if (!user) {
      return res.status(404).json({ error: 'No encontramos tu cuenta' });
    }

    if (!user.qrCode) {
      return res.status(404).json({ error: 'No tenes un QR disponible' });
    }

    const qrStatus = user.qrStatus || 'active';
    const qrDataUrl = qrStatus === 'active' ? await QRCode.toDataURL(buildHostQrUrl(user.qrCode)) : null;
    const latestPlateRequest = await QrPlateReport.findOne({
      user: user._id,
      asset: 'plate',
      type: { $in: ['new_plate', 'replacement'] },
    }).sort({ createdAt: -1 }).select('status statusHistory createdAt installationScheduledAt').lean();
    const plateRequestStatusMap = {
      open: 'pending',
      in_review: 'in_production',
      resolved: 'installed',
      pending: 'pending',
      in_production: 'in_production',
      ready_for_installation: 'ready_for_installation',
      installed: 'installed',
      rejected: 'rejected',
    };
    const plateRequestHistory = latestPlateRequest
      ? (Array.isArray(latestPlateRequest.statusHistory) && latestPlateRequest.statusHistory.length
        ? latestPlateRequest.statusHistory
        : [{ status: latestPlateRequest.status, changedAt: latestPlateRequest.createdAt }]
      ).map((entry) => ({
        status: plateRequestStatusMap[entry.status] || 'pending',
        changedAt: entry.changedAt || latestPlateRequest.createdAt,
      }))
      : [];

    return res.json({
      qrCode: user.qrCode,
      qrDataUrl,
      name: user.name,
      qrStatus,
      plateStatus: user.plateStatus || 'active',
      plateReplacementRequestedAt: user.plateReplacementRequestedAt || null,
      plateInstalledAt: user.plateInstalledAt || null,
      plateRequestStatus: latestPlateRequest ? plateRequestStatusMap[latestPlateRequest.status] || 'pending' : 'none',
      plateRequestHistory,
      installationScheduledAt: latestPlateRequest?.installationScheduledAt || null,
      visitorSettingsConfigured: user.visitorSettingsConfigured === true,
      visitorDisplayName: user.visitorDisplayName || null,
      visitorWelcomeMessage: user.visitorWelcomeMessage || null,
      visitorStatus: user.visitorStatus || 'available',
      visitorSchedule: user.visitorSchedule || [],
    });
  } catch (error) {
    console.error('Error generando QR dinamico:', error);
    return res.status(500).json({ error: 'No pudimos generar tu QR' });
  }
}

async function login(req, res) {
  const email = validateEmail(req.body.email);
  const { password } = req.body;
  const rememberMe = req.body.rememberMe === true;

  try {
    if (!email || typeof password !== 'string' || password.trim() === '') {
      return res.status(400).json({ error: 'Completá tu correo y contrasena' });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Correo o contrasena incorrectos' });

    if (user.emailVerified === false) {
      return res.status(403).json({
        error: 'Verifica tu correo antes de ingresar',
        code: 'EMAIL_NOT_VERIFIED',
        requiresEmailVerification: true,
        email: user.email,
        user: buildUserPayload(user),
        emailVerificationExpiresAt: user.emailOtpExpiresAt,
        emailVerificationResendAvailableAt: user.emailOtpLastSentAt
          ? new Date(new Date(user.emailOtpLastSentAt).getTime() + OTP_RESEND_COOLDOWN_MS)
          : null,
      });
    }

    if (!user.password) {
      return res.status(400).json({ error: 'Esta cuenta no tiene contrasena configurada' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Correo o contrasena incorrectos' });

    return res.json({
      token: createToken(user, rememberMe),
      user: {
        id: user._id,
        name: user.name,
        role: ['admin', 'plate_manager', 'technician'].includes(user.role) ? user.role : 'host',
        qrCode: user.qrCode || null,
        email: user.email,
        emailVerified: user.emailVerified !== false,
      },
    });
  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ error: 'No pudimos iniciar sesion' });
  }
}

async function getMe(req, res) {
  try {
    const user = await User.findById(req.user._id).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'No encontramos tu cuenta' });
    }

    return res.json(buildUserPayload(user));
  } catch (error) {
    console.error('Error obteniendo datos del usuario:', error);
    return res.status(500).json({ error: 'No pudimos cargar tus datos' });
  }
}

async function getHostByQr(req, res) {
  try {
    const qrCode = validateQrCode(req.params.qrCode);
    if (!qrCode) {
      return res.status(400).json({
        error: 'No pudimos leer ese QR',
        success: false,
      });
    }

    const host = await User.findOne({ qrCode, role: 'host' }).select('name email _id qrCode qrStatus visitorDisplayName visitorWelcomeMessage visitorStatus visitorSchedule');

    if (!host) {
      return res.status(404).json({
        error: 'No encontramos al anfitrion para ese QR',
        success: false,
      });
    }

    if ((host.qrStatus || 'active') !== 'active') {
      return res.status(410).json({ error: 'Este QR no esta disponible', code: `QR_${String(host.qrStatus || 'active').toUpperCase()}`, success: false });
    }

    return res.json({
      host: {
        email: host.email,
        id: host._id,
        name: host.name,
        qrCode: host.qrCode,
        visitorDisplayName: host.visitorDisplayName || null,
        visitorWelcomeMessage: host.visitorWelcomeMessage || null,
        visitorStatus: host.visitorStatus || 'available',
        effectiveVisitorStatus: getEffectiveVisitorStatus(host),
        visitorSchedule: host.visitorSchedule || [],
      },
      success: true,
    });
  } catch (error) {
    console.error('Error obteniendo host por QR:', error);
    return res.status(500).json({
      error: 'No pudimos obtener la informacion de ese QR',
      success: false,
    });
  }
}

async function verifyEmail(req, res) {
  const email = validateEmail(req.body.email);
  const otp = normalizeOtpCode(req.body.otp);

  try {
    if (!email || !isValidOtpFormat(otp)) {
      return res.status(400).json({ error: 'Escribi un codigo de 6 digitos valido', code: 'INVALID_OTP_FORMAT' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'No pudimos verificar ese codigo', code: 'OTP_INVALID' });
    }

    if (user.emailVerified === true) {
      return res.json({
        success: true,
        verified: true,
        message: 'Tu correo ya estaba verificado',
      });
    }

    if (canBypassOtpValidation(otp)) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      clearEmailOtp(user);
      await user.save();

      return res.json({
        success: true,
        verified: true,
        token: createToken(user),
        user: buildUserPayload(user),
        message: 'Correo verificado correctamente',
      });
    }

    if (isOtpExpired(user.emailOtpExpiresAt) || !user.emailOtpHash) {
      clearEmailOtp(user);
      await user.save();
      return res.status(400).json({ error: 'Ese codigo vencio. Pedi uno nuevo.', code: 'OTP_EXPIRED' });
    }

    if (user.emailOtpAttempts >= MAX_OTP_ATTEMPTS) {
      clearEmailOtp(user);
      await user.save();
      return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.', code: 'OTP_MAX_ATTEMPTS' });
    }

    const expectedHash = hashOtpCode({
      email,
      purpose: 'email-verification',
      code: otp,
    });

    if (expectedHash !== user.emailOtpHash) {
      user.emailOtpAttempts += 1;

      if (user.emailOtpAttempts >= MAX_OTP_ATTEMPTS) {
        clearEmailOtp(user);
        await user.save();
        return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.', code: 'OTP_MAX_ATTEMPTS' });
      }

      await user.save();
      return res.status(400).json({ error: 'Ese codigo no es correcto', code: 'OTP_INVALID' });
    }

    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    clearEmailOtp(user);
    await user.save();

    return res.json({
      success: true,
      verified: true,
      token: createToken(user),
      user: buildUserPayload(user),
      message: 'Correo verificado correctamente',
    });
  } catch (error) {
    console.error('Error verificando email:', error);
    return res.status(500).json({ error: 'No pudimos verificar tu correo' });
  }
}

async function resendEmailOtp(req, res) {
  const email = validateEmail(req.body.email);

  try {
    if (!email) {
      return res.status(400).json({ error: 'Escribi un correo valido' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.json({
        success: true,
        message: 'Si la cuenta existe, reenviamos un nuevo codigo.',
      });
    }

    if (user.emailVerified === true) {
      return res.json({
        success: true,
        verified: true,
        message: 'Tu correo ya estaba verificado.',
      });
    }

    if (NODEMAILER_BYPASS_ENABLED) {
      return res.json({
        success: true,
        message: 'Si la cuenta existe, reenviamos un nuevo codigo.',
      });
    }

    if (!canResendEmailOtp(user)) {
      return res.status(429).json({
        error: 'Espera un momento antes de pedir otro codigo.',
        code: 'OTP_RESEND_COOLDOWN',
        retryAfterSeconds: Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(user.emailOtpLastSentAt).getTime())) / 1000),
        nextAllowedAt: new Date(new Date(user.emailOtpLastSentAt).getTime() + OTP_RESEND_COOLDOWN_MS),
      });
    }

    const otpCode = await issueVerificationOtp(user);
    await sendVerificationCodeEmail({
      to: user.email,
      name: user.name,
      code: otpCode,
    });

    return res.json({
      success: true,
      message: 'Si la cuenta existe, reenviamos un nuevo codigo.',
      expiresAt: user.emailOtpExpiresAt,
      nextAllowedAt: new Date(Date.now() + OTP_RESEND_COOLDOWN_MS),
    });
  } catch (error) {
    console.error('Error reenviando codigo de verificacion:', error);
    return res.status(500).json({ error: 'No pudimos reenviar el codigo' });
  }
}

async function forgotPassword(req, res) {
  const email = validateEmail(req.body.email);

  try {
    if (!email) {
      return res.status(400).json({ error: 'Escribi un correo valido' });
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.json({
        success: true,
        message: 'Si la cuenta existe, enviamos un codigo de recuperacion.',
      });
    }

    if (user.passwordResetRequestedAt && Date.now() - new Date(user.passwordResetRequestedAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
      return res.status(429).json({
        error: 'Espera un momento antes de pedir otro codigo de recuperacion.',
        code: 'OTP_RESEND_COOLDOWN',
        retryAfterSeconds: Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(user.passwordResetRequestedAt).getTime())) / 1000),
        nextAllowedAt: new Date(new Date(user.passwordResetRequestedAt).getTime() + OTP_RESEND_COOLDOWN_MS),
      });
    }

    if (!NODEMAILER_BYPASS_ENABLED) {
      const resetCode = await issuePasswordResetOtp(user);
      await sendPasswordResetCodeEmail({
        to: user.email,
        name: user.name,
        code: resetCode,
      });
    }

    return res.json({
      success: true,
      message: 'Si la cuenta existe, enviamos un codigo de recuperacion.',
      expiresAt: user.passwordResetExpiresAt,
      nextAllowedAt: new Date(Date.now() + OTP_RESEND_COOLDOWN_MS),
    });
  } catch (error) {
    console.error('Error iniciando recuperacion de contrasena:', error);
    return res.status(500).json({ error: 'No pudimos enviar el codigo de recuperacion' });
  }
}

async function resetPassword(req, res) {
  const email = validateEmail(req.body.email);
  const otp = normalizeOtpCode(req.body.otp);
  const { newPassword, passwordConfirmation } = req.body;
  const cleanPassword = validatePassword(newPassword);

  try {
    if (!email) {
      return res.status(400).json({ error: 'Escribi un correo valido', code: 'INVALID_EMAIL' });
    }

    if (!isValidOtpFormat(otp)) {
      return res.status(400).json({ error: 'Escribi un codigo de 6 digitos valido', code: 'INVALID_OTP_FORMAT' });
    }

    if (!cleanPassword) {
      return res.status(400).json({ error: 'La nueva contrasena debe tener entre 8 y 128 caracteres', code: 'INVALID_PASSWORD' });
    }

    if (newPassword !== passwordConfirmation) {
      return res.status(400).json({ error: 'Las contrasenas no coinciden', code: 'PASSWORD_MISMATCH' });
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.status(400).json({ error: 'No pudimos verificar ese codigo', code: 'OTP_INVALID' });
    }

    if (canBypassOtpValidation(otp)) {
      user.password = await bcrypt.hash(cleanPassword, 10);
      user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
      clearPasswordResetOtp(user);
      await user.save();

      const payload = {
        success: true,
        message: 'Contrasena actualizada correctamente',
      };

      if (user.emailVerified !== false) {
        payload.token = createToken(user);
        payload.user = buildUserPayload(user);
      }

      return res.json(payload);
    }

    if (isOtpExpired(user.passwordResetExpiresAt) || !user.passwordResetTokenHash) {
      clearPasswordResetOtp(user);
      await user.save();
      return res.status(400).json({ error: 'Ese codigo vencio. Pedi uno nuevo.', code: 'OTP_EXPIRED' });
    }

    if (user.passwordResetAttempts >= MAX_OTP_ATTEMPTS) {
      clearPasswordResetOtp(user);
      await user.save();
      return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.', code: 'OTP_MAX_ATTEMPTS' });
    }

    const expectedHash = hashOtpCode({
      email,
      purpose: 'password-reset',
      code: otp,
    });

    if (expectedHash !== user.passwordResetTokenHash) {
      user.passwordResetAttempts += 1;

      if (user.passwordResetAttempts >= MAX_OTP_ATTEMPTS) {
        clearPasswordResetOtp(user);
        await user.save();
        return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.', code: 'OTP_MAX_ATTEMPTS' });
      }

      await user.save();
      return res.status(400).json({ error: 'Ese codigo no es correcto', code: 'OTP_INVALID' });
    }

    user.password = await bcrypt.hash(cleanPassword, 10);
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
    clearPasswordResetOtp(user);
    await user.save();

    const payload = {
      success: true,
      message: 'Contrasena actualizada correctamente',
    };

    if (user.emailVerified !== false) {
      payload.token = createToken(user);
      payload.user = buildUserPayload(user);
    }

    return res.json(payload);
  } catch (error) {
    console.error('Error reseteando contrasena:', error);
    return res.status(500).json({ error: 'No pudimos actualizar la contrasena' });
  }
}

async function resendPasswordResetOtp(req, res) {
  const email = validateEmail(req.body.email);

  try {
    if (!email) {
      return res.status(400).json({ error: 'Escribi un correo valido', code: 'INVALID_EMAIL' });
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.json({ success: true, message: 'Si la cuenta existe, reenviamos un nuevo codigo.' });
    }

    if (user.passwordResetRequestedAt && Date.now() - new Date(user.passwordResetRequestedAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
      return res.status(429).json({
        error: 'Espera un momento antes de pedir otro codigo de recuperacion.',
        code: 'OTP_RESEND_COOLDOWN',
        retryAfterSeconds: Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(user.passwordResetRequestedAt).getTime())) / 1000),
        nextAllowedAt: new Date(new Date(user.passwordResetRequestedAt).getTime() + OTP_RESEND_COOLDOWN_MS),
      });
    }

    if (!NODEMAILER_BYPASS_ENABLED) {
      const resetCode = await issuePasswordResetOtp(user);
      await sendPasswordResetCodeEmail({ to: user.email, name: user.name, code: resetCode });
    }

    return res.json({
      success: true,
      message: 'Si la cuenta existe, reenviamos un nuevo codigo.',
      expiresAt: user.passwordResetExpiresAt,
      nextAllowedAt: new Date(Date.now() + OTP_RESEND_COOLDOWN_MS),
    });
  } catch (error) {
    console.error('Error reenviando codigo de recuperacion:', error);
    return res.status(500).json({ error: 'No pudimos reenviar el codigo de recuperacion' });
  }
}

module.exports = {
  registerHost,
  login,
  getMe,
  getHostByQr,
  getMyQr,
  verifyEmail,
  resendEmailOtp,
  forgotPassword,
  resendPasswordResetOtp,
  resetPassword,
};
