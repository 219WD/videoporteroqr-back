const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const messageSchema = new mongoose.Schema({
  sender: {
    type: String,
    enum: ['host', 'guest'],
    required: true
  },
  message: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const doorbellCallSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => `call-${uuidv4()}`
  },
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  guestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  guestName: {
    type: String,
    required: true,
    default: 'Visitante'
  },
  // guestEmail: {
  //   type: String,
  //   required: true
  // },
  // guestPhone: {
  //   type: String,
  //   default: null
  // },
  // guestCompany: {
  //   type: String,
  //   default: null
  // },
  status: {
    type: String,
    enum: ['pending', 'answered', 'timeout', 'rejected'],
    default: 'pending'
  },
  callType: {
    type: String,
    enum: ['doorbell', 'video', 'message'],
    default: 'doorbell'
  },
  actionType: {
    type: String,
    enum: ['call', 'message', 'direct_call'],
    default: 'call'
  },
  response: {
    type: String,
    enum: ['accept', 'reject', 'timeout'],
    default: null
  },
  answeredAt: {
    type: Date
  },
  qrCode: {
    type: String
  },
  isAnonymous: {
    type: Boolean,
    default: true
  },
  guestDataProvided: {
    type: Boolean,
    default: false
  },
  messageContent: {
    type: String,
    default: null
  },
  firstNotificationAt: Date,
  secondNotificationAt: Date,
  messages: [messageSchema],
  timeoutAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
  }
}, {
  timestamps: true,
  _id: false
});

doorbellCallSchema.index({ hostId: 1, status: 1, createdAt: -1 });
doorbellCallSchema.index({ guestId: 1, createdAt: -1 });
doorbellCallSchema.index({ qrCode: 1 });

module.exports = mongoose.model('DoorbellCall', doorbellCallSchema);


