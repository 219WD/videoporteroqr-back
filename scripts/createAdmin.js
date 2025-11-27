const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const User = require('../models/User');

async function create() {
  await mongoose.connect(process.env.MONGO_URI);
  const hashed = await bcrypt.hash('admin123', 10);
  await User.create({ name: 'Admin', email: 'admin@local', password: hashed, role: 'admin' });
  console.log('Admin creado');
  process.exit(0);
}
create();