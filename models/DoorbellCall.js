// models/DoorbellCall.js - MEJORAR el manejo de timeout
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

const doorbellCallSchema = new mongoose.Schema({
  hostId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  guestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null,
  },
  guestName: {
    type: String,
    required: true
  },
  guestEmail: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'answered', 'timeout'],
    default: 'pending'
  },
  callType: {
    type: String,
    enum: ['doorbell', 'video'],
    default: 'doorbell'
  },
  response: {
    type: String,
    enum: ['accept', 'reject']
  },
  answeredAt: {
    type: Date
  },
  messages: [messageSchema],
  timeoutAt: {
    type: Date,
    default: () => new Date(Date.now() + 35 * 1000) // 35 segundos para testing
  }
}, {
  timestamps: true
});

// Middleware para marcar como timeout antes de la eliminación
doorbellCallSchema.pre('deleteOne', { document: true }, function(next) {
  console.log(`⏰ Llamada ${this._id} expirando por TTL`);
  next();
});

// Índice TTL para limpieza automática (aumentado a 5 minutos para testing)
doorbellCallSchema.index({ timeoutAt: 1 }, { 
  expireAfterSeconds: 300 // 5 minutos
});

module.exports = mongoose.model('DoorbellCall', doorbellCallSchema);