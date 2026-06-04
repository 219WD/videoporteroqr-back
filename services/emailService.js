const transporter = require('../config/nodemailer');
const {
  APP_PUBLIC_URL,
  NODEMAILER_USER,
  NODEMAILER_PASSWORD,
  NODEMAILER_BYPASS_ENABLED,
} = require('../config/env');

function ensureMailConfig() {
  if (!NODEMAILER_USER || !NODEMAILER_PASSWORD) {
    throw new Error('Nodemailer no configurado');
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildOtpEmailHtml({
  brandName = 'QR Door',
  title,
  intro,
  code,
  footer,
  ctaLabel,
  ctaUrl,
  accentLabel,
  expiryLabel,
}) {
  const appUrl = APP_PUBLIC_URL.replace(/\/$/, '');
  const safeBrandName = escapeHtml(brandName);
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeCode = escapeHtml(code);
  const safeFooter = escapeHtml(footer);
  const safeCtaLabel = escapeHtml(ctaLabel);
  const safeCtaUrl = escapeHtml(ctaUrl || appUrl);
  const safeAccentLabel = escapeHtml(accentLabel);
  const safeExpiryLabel = escapeHtml(expiryLabel);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: Arial, sans-serif;
      background: #f4f4f4;
    }

    .wrap {
      max-width: 600px;
      margin: 30px auto;
      background: #fff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
    }

    .header {
      background: linear-gradient(135deg, #7d1522, #961c2c);
      padding: 32px 24px;
      text-align: center;
    }

    .header img {
      width: 90px;
      margin-bottom: 14px;
      display: block;
      margin-left: auto;
      margin-right: auto;
    }

    .header h1 {
      color: #fff;
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .header p {
      color: rgba(255, 255, 255, 0.85);
      font-size: 14px;
    }

    .body {
      padding: 28px 32px;
    }

    .body h2 {
      font-size: 20px;
      color: #1a1a1a;
      margin-bottom: 12px;
    }

    .body p {
      font-size: 14px;
      color: #555;
      line-height: 1.7;
      margin-bottom: 10px;
    }

    .otp-box {
      margin: 20px 0;
      border: 2px dashed #961c2c;
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      background: #fff5f6;
    }

    .otp-box .label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: #961c2c;
      margin-bottom: 8px;
    }

    .otp-box .code {
      font-size: 48px;
      font-weight: 900;
      color: #961c2c;
      line-height: 1;
      letter-spacing: 0.16em;
    }

    .otp-box .hint {
      font-size: 12px;
      color: #666;
      margin-top: 12px;
      margin-bottom: 0;
    }

    .info-card {
      background: #f8f8f8;
      border-radius: 10px;
      padding: 18px;
      margin-top: 20px;
      margin-bottom: 20px;
    }

    .info-card h4 {
      font-size: 12px;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .info-card p {
      font-size: 12px;
      color: #555;
      margin-bottom: 5px;
    }

    .cta {
      text-align: center;
      margin: 24px 0;
    }

    .cta a {
      display: inline-block;
      background: #961c2c;
      color: #fff;
      text-decoration: none;
      font-size: 14px;
      font-weight: 700;
      padding: 13px 32px;
      border-radius: 10px;
    }

    .footer {
      background: #1a1a1a;
      padding: 18px 32px;
      text-align: center;
    }

    .footer p {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.55);
      margin-bottom: 5px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <img src="https://res.cloudinary.com/dtxdv136u/image/upload/v1763499836/logo_alb_ged07k.png" alt="${safeBrandName}" />
      <h1>${safeTitle}</h1>
      <p>${safeAccentLabel}</p>
    </div>

    <div class="body">
      <h2>Hola</h2>
      <p>${safeIntro}</p>

      <div class="otp-box">
        <div class="label">Codigo de verificacion</div>
        <div class="code">${safeCode}</div>
        <p class="hint">${safeExpiryLabel}</p>
      </div>

      <div class="info-card">
        <h4>Importante</h4>
        <p>${safeFooter}</p>
        <p>Si no fuiste vos, podés ignorar este mensaje.</p>
      </div>

      <div class="cta">
        <a href="${safeCtaUrl}">${safeCtaLabel}</a>
      </div>
    </div>

    <div class="footer">
      <p>Este es un mail automatizado de ${safeBrandName}.</p>
      <p>No respondas a este mensaje.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildOtpEmailText({ title, intro, code, footer, expiryLabel }) {
  return [
    title,
    '',
    intro,
    '',
    `Codigo de verificacion: ${code}`,
    expiryLabel,
    '',
    footer,
  ].join('\n');
}

async function sendEmail({ to, subject, html, text }) {
  if (NODEMAILER_BYPASS_ENABLED) {
    return { bypassed: true, to, subject };
  }

  ensureMailConfig();

  const info = await transporter.sendMail({
    from: `"QR Door" <${NODEMAILER_USER}>`,
    to,
    subject,
    html,
    text,
  });

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  };
}

async function sendVerificationCodeEmail({ to, name, code }) {
  if (NODEMAILER_BYPASS_ENABLED) {
    return { bypassed: true, to, purpose: 'verification' };
  }

  const title = 'Verificacion de correo';
  const intro = `Hola${name ? ` ${name}` : ''}, este es tu codigo para verificar tu correo en QR Door.`;
  const footer = 'Ingresa este codigo en la pantalla de verificacion para activar tu cuenta.';
  const expiryLabel = 'Este codigo vence en pocos minutos.';

  return sendEmail({
    to,
    subject: title,
    html: buildOtpEmailHtml({
      title,
      intro,
      code,
      footer,
      ctaLabel: 'Verificar correo',
      ctaUrl: APP_PUBLIC_URL,
      accentLabel: 'Verificacion de cuenta',
      expiryLabel,
    }),
    text: buildOtpEmailText({
      title,
      intro,
      code,
      footer,
      expiryLabel,
    }),
  });
}

async function sendPasswordResetCodeEmail({ to, name, code }) {
  if (NODEMAILER_BYPASS_ENABLED) {
    return { bypassed: true, to, purpose: 'password-reset' };
  }

  const title = 'Recuperar contrasena';
  const intro = `Hola${name ? ` ${name}` : ''}, pediste recuperar el acceso a tu cuenta en QR Door.`;
  const footer = 'Ingresa este codigo en la pantalla de recuperacion para crear una nueva contrasena.';
  const expiryLabel = 'Este codigo vence en pocos minutos.';

  return sendEmail({
    to,
    subject: title,
    html: buildOtpEmailHtml({
      title,
      intro,
      code,
      footer,
      ctaLabel: 'Recuperar contrasena',
      ctaUrl: APP_PUBLIC_URL,
      accentLabel: 'Recuperacion de acceso',
      expiryLabel,
    }),
    text: buildOtpEmailText({
      title,
      intro,
      code,
      footer,
      expiryLabel,
    }),
  });
}

module.exports = {
  sendVerificationCodeEmail,
  sendPasswordResetCodeEmail,
};
