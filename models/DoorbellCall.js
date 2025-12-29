const mongoose = require('mongoose');

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

const pushNotificationSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['initial', 'message', 'call', 'message_details', 'start_videocall']
  },
  sentAt: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['sent', 'delivered', 'error'],
    default: 'sent'
  }
});

const doorbellCallSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: () => `call-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
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
  pushNotifications: [pushNotificationSchema],
  firstNotificationAt: Date,
  secondNotificationAt: Date,
  messages: [messageSchema],
  timeoutAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 horas
  }
}, {
  timestamps: true,
  _id: false
});

module.exports = mongoose.model('DoorbellCall', doorbellCallSchema);