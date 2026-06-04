const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const User = require('../models/User');
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

function createToken(user) {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      ver: Number.isFinite(Number(user.tokenVersion)) ? Number(user.tokenVersion) : 0,
    },
    JWT_SECRET,
    {
      expiresIn: '7d',
    },
  );
}

function buildUserPayload(user) {
  const normalizedRole = user.role === 'admin' ? 'admin' : 'host';

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
  const { name, password } = req.body;
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
      return res.status(400).json({ error: 'Escribi una contrasena valida' });
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
    const user = await User.findById(req.user._id).select('qrCode role');

    if (!user) {
      return res.status(404).json({ error: 'No encontramos tu cuenta' });
    }

    if (!user.qrCode) {
      return res.status(404).json({ error: 'No tenes un QR disponible' });
    }

    const qrDataUrl = await QRCode.toDataURL(buildHostQrUrl(user.qrCode));

    return res.json({
      qrCode: user.qrCode,
      qrDataUrl,
    });
  } catch (error) {
    console.error('Error generando QR dinamico:', error);
    return res.status(500).json({ error: 'No pudimos generar tu QR' });
  }
}

async function login(req, res) {
  const email = validateEmail(req.body.email);
  const { password } = req.body;

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
      });
    }

    if (!user.password) {
      return res.status(400).json({ error: 'Esta cuenta no tiene contrasena configurada' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Correo o contrasena incorrectos' });

    return res.json({
      token: createToken(user),
      user: {
        id: user._id,
        name: user.name,
        role: user.role === 'admin' ? 'admin' : 'host',
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

    const host = await User.findOne({ qrCode, role: 'host' }).select('name email _id qrCode');

    if (!host) {
      return res.status(404).json({
        error: 'No encontramos al anfitrion para ese QR',
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
      return res.status(400).json({ error: 'Escribi un codigo valido' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'No pudimos verificar ese codigo' });
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
      return res.status(400).json({ error: 'Ese codigo vencio. Pedi uno nuevo.' });
    }

    if (user.emailOtpAttempts >= MAX_OTP_ATTEMPTS) {
      clearEmailOtp(user);
      await user.save();
      return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.' });
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
        return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.' });
      }

      await user.save();
      return res.status(400).json({ error: 'Ese codigo no es correcto' });
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
    });
  } catch (error) {
    console.error('Error iniciando recuperacion de contrasena:', error);
    return res.status(500).json({ error: 'No pudimos enviar el codigo de recuperacion' });
  }
}

async function resetPassword(req, res) {
  const email = validateEmail(req.body.email);
  const otp = normalizeOtpCode(req.body.otp);
  const newPassword = validatePassword(req.body.newPassword);

  try {
    if (!email || !isValidOtpFormat(otp) || !newPassword) {
      return res.status(400).json({ error: 'Revisa el correo, el codigo y la nueva contrasena' });
    }

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.status(400).json({ error: 'No pudimos verificar ese codigo' });
    }

    if (canBypassOtpValidation(otp)) {
      user.password = await bcrypt.hash(newPassword, 10);
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
      return res.status(400).json({ error: 'Ese codigo vencio. Pedi uno nuevo.' });
    }

    if (user.passwordResetAttempts >= MAX_OTP_ATTEMPTS) {
      clearPasswordResetOtp(user);
      await user.save();
      return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.' });
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
        return res.status(429).json({ error: 'Hiciste demasiados intentos. Pedi un codigo nuevo.' });
      }

      await user.save();
      return res.status(400).json({ error: 'Ese codigo no es correcto' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
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

module.exports = {
  registerHost,
  login,
  getMe,
  getHostByQr,
  getMyQr,
  verifyEmail,
  resendEmailOtp,
  forgotPassword,
  resetPassword,
};
