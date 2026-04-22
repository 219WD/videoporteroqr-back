const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    pairKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    participantIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
    ],
    participantStates: {
      type: [
        {
          userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
          },
          lastReadAt: {
            type: Date,
            default: null,
          },
          unreadCount: {
            type: Number,
            default: 0,
          },
        },
      ],
      default: [],
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
    lastMessageSenderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastMessageSenderName: {
      type: String,
      default: null,
      trim: true,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

conversationSchema.index({ participantIds: 1, lastMessageAt: -1 });
conversationSchema.index({ pairKey: 1 }, { unique: true });

module.exports = mongoose.model('Conversation', conversationSchema);
