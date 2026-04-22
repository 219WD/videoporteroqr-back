
const mongoose = require('mongoose');

const guestLinkSchema = new mongoose.Schema(
  {
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    linkedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const hostLinkSchema = new mongoose.Schema(
  {
    hostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    linkedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
  password: { type: String },
  role: { type: String, enum: ['admin', 'host'], default: 'host' },
  guests: { type: [guestLinkSchema], default: [] },
  hostRefs: { type: [hostLinkSchema], default: [] },
  qrCode: { type: String, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);


