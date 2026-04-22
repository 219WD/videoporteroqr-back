
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = require('../config/env');
const { validateEmail, validateName, validatePassword } = require('../utils/validation');
const { createScopedLogger } = require('../utils/logger');

const logger = createScopedLogger('seed:admin');

async function seedAdminUser() {
  const name = validateName(ADMIN_NAME);
  const email = validateEmail(ADMIN_EMAIL);
  const password = validatePassword(ADMIN_PASSWORD);

  if (!name || !email || !password) {
    logger.warn('Admin seed omitido: faltan variables ADMIN_NAME, ADMIN_EMAIL o ADMIN_PASSWORD');
    return null;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const existing = await User.findOne({ email });

  if (existing) {
    existing.name = name;
    existing.password = hashedPassword;
    existing.role = 'admin';
    await existing.save();

    logger.info('Admin actualizado desde variables de entorno', { email });
    return existing;
  }

  const admin = await User.create({
    email,
    name,
    password: hashedPassword,
    role: 'admin',
  });

  logger.info('Admin inyectado en MongoDB', { email });
  return admin;
}

module.exports = {
  seedAdminUser,
};


