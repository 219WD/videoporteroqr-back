const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  password: { type: String },
  role: { type: String, enum: ['admin', 'host', 'guest'], default: 'guest' },
  hostRef: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  qrCode: { type: String, unique: true, sparse: true }, // only for hosts
  qrDataUrl: { type: String }, // base64 image (optional)
  pushToken: { type: String, default: null }, // expo push token
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);
