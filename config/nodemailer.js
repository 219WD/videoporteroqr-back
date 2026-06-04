const nodemailer = require('nodemailer');
const { NODEMAILER_USER, NODEMAILER_PASSWORD } = require('./env');

console.log('Configurando Nodemailer para SMTP Gmail...');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: NODEMAILER_USER,
    pass: NODEMAILER_PASSWORD,
  },
  connectionTimeout: 30000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  tls: {
    rejectUnauthorized: false,
  },
});

// Verificacion SMTP opcional:
// transporter.verify((error) => {
//   if (error) {
//     console.log('Verificacion SMTP opcional fallo:', error.message);
//   } else {
//     console.log('Servidor SMTP configurado correctamente');
//   }
// });

module.exports = transporter;
