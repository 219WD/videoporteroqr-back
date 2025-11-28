// models/DoorbellCall.js - VERSIÓN CORREGIDA Y COMPLETA
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
    default: () => new Date(Date.now() + 35 * 1000)
  },
  // ESTOS DOS CAMPOS SON LA CLAVE
  callId: { type: String, required: true },     // <-- AÑADIDO
  qrCode: { type: String },                     // <-- AÑADIDO (opcional, para debug)
}, {
  timestamps: true
});

// TTL para limpiar llamadas viejas
doorbellCallSchema.index({ timeoutAt: 1 }, { expireAfterSeconds: 300 });

module.exports = mongoose.model('DoorbellCall', doorbellCallSchema);