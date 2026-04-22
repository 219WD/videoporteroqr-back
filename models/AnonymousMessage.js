const mongoose = require('mongoose');

const anonymousMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
      ref: 'AnonymousConversation',
    },
    sender: {
      type: String,
      enum: ['host', 'guest'],
      required: true,
    },
    senderName: {
      type: String,
      required: true,
      trim: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

anonymousMessageSchema.index({ conversationId: 1, createdAt: 1 });
anonymousMessageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('AnonymousMessage', anonymousMessageSchema);
