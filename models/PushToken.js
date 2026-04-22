
const mongoose = require('mongoose');

const PushTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    deviceId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['ios', 'android', 'web', 'unknown'],
      default: 'unknown',
      trim: true,
    },
    expoProjectId: {
      type: String,
      default: null,
      trim: true,
    },
    appVersion: {
      type: String,
      default: null,
      trim: true,
    },
    enabled: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model('PushToken', PushTokenSchema);
