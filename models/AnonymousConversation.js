const mongoose = require('mongoose');

const anonymousConversationSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    hostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    guestName: {
      type: String,
      required: true,
      trim: true,
    },
    qrCode: {
      type: String,
      required: true,
      index: true,
    },
    actionType: {
      type: String,
      enum: ['message', 'call'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'answered', 'timeout', 'rejected'],
      default: 'pending',
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    lastMessageText: {
      type: String,
      default: null,
      trim: true,
    },
    lastMessageSender: {
      type: String,
      enum: ['host', 'guest', null],
      default: null,
    },
    hostUnreadCount: {
      type: Number,
      default: 0,
    },
    isAnonymous: {
      type: Boolean,
      default: true,
    },
    timeoutAt: {
      type: Date,
      default: null,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    response: {
      type: String,
      enum: ['accept', 'reject', 'timeout', null],
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

anonymousConversationSchema.index({ hostId: 1, lastMessageAt: -1 });
anonymousConversationSchema.index({ hostId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('AnonymousConversation', anonymousConversationSchema);
