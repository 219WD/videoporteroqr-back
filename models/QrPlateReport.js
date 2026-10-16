const mongoose = require('mongoose');

const QrPlateReportSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  asset: { type: String, enum: ['qr', 'plate'], required: true },
  type: { type: String, enum: ['damaged', 'unreadable', 'lost', 'replacement', 'new_plate'], required: true },
  status: { type: String, enum: ['open', 'in_review', 'resolved', 'pending', 'in_production', 'ready_for_installation', 'installed', 'rejected'], default: 'open', index: true },
  note: { type: String, trim: true, maxlength: 500, default: null },
  shippingAddress: { type: String, trim: true, maxlength: 300, default: null },
  contactPhone: { type: String, trim: true, maxlength: 40, default: null },
  installationScheduledAt: { type: Date, default: null },
  assignedTechnician: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  technicianAssignedAt: { type: Date, default: null },
  statusHistory: {
    type: [{
      status: { type: String, enum: ['open', 'in_review', 'resolved', 'pending', 'in_production', 'ready_for_installation', 'installed', 'rejected'], required: true },
      changedAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
  createdAt: { type: Date, default: Date.now, index: true },
  resolvedAt: { type: Date, default: null },
});

QrPlateReportSchema.index({ user: 1, asset: 1, status: 1 });

module.exports = mongoose.model('QrPlateReport', QrPlateReportSchema);
