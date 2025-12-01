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
  // ✅ CAMBIAR _id a String para aceptar IDs personalizados
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
    required: true
  },
  guestEmail: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'answered', 'timeout', 'rejected'],
    default: 'pending'
  },
  callType: {
    type: String,
    enum: ['doorbell', 'video'],
    default: 'doorbell'
  },
  response: {
    type: String,
    enum: ['accept', 'reject', 'timeout'],
    default: null
  },
  answeredAt: {
    type: Date
  },
  qrCode: { // ✅ Añadir este campo para guardar el QR
    type: String
  },
  isAnonymous: {
    type: Boolean,
    default: false
  },
  messages: [messageSchema]
}, {
  timestamps: true,
  // ✅ DESACTIVAR LA GENERACIÓN AUTOMÁTICA DE _id
  _id: false 
});

module.exports = mongoose.model('DoorbellCall', doorbellCallSchema);