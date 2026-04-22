
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const CallSessionSchema = new mongoose.Schema(
  {
    callId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: () => `call-${uuidv4()}`,
    },
    roomId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: function defaultRoomId() {
        return `room-${this.callId || uuidv4()}`;
      },
    },
    pairKey: {
      type: String,
      required: true,
      index: true,
    },
    callerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    calleeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    callerName: {
      type: String,
      required: true,
      trim: true,
    },
    calleeName: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['ringing', 'accepted', 'rejected', 'ended', 'missed', 'timeout', 'cancelled'],
      default: 'ringing',
      index: true,
    },
    lastEventAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    endedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reason: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

CallSessionSchema.index({ pairKey: 1, status: 1, createdAt: -1 });

CallSessionSchema.pre('save', function preSave(next) {
  this.lastEventAt = new Date();

  if (!this.roomId) {
    this.roomId = `room-${this.callId}`;
  }

  next();
});

module.exports = mongoose.model('CallSession', CallSessionSchema);
