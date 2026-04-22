
function isSameId(left, right) {
  if (!left || !right) return false;
  return left.toString() === right.toString();
}

function isCallParticipant(user, call) {
  if (!user || !call) return false;
  return isSameId(user._id, call.hostId) || isSameId(user._id, call.guestId);
}

function isHostOwner(user, call) {
  if (!user || !call) return false;
  return isSameId(user._id, call.hostId);
}

function loadCallById(model, callId) {
  return model.findById(callId);
}

function markCallResponded(call, response, answeredAt = new Date()) {
  call.status = response === 'timeout' ? 'timeout' : 'answered';
  call.response = response;
  call.answeredAt = answeredAt;
  return call;
}

function appendCallMessage(call, sender, message) {
  call.messages.push({
    sender,
    message: message.trim(),
    timestamp: new Date(),
  });

  return call;
}

function toCallSummary(call) {
  return {
    _id: call._id,
    answeredAt: call.answeredAt,
    callType: call.callType || 'doorbell',
    createdAt: call.createdAt,
    guestEmail: call.guestEmail,
    guestId: call.guestId,
    guestName: call.guestName,
    isAnonymous: call.isAnonymous || false,
    qrCode: call.qrCode,
    response: call.response,
    status: call.status,
  };
}

function toTimedOutSummary(call, timeoutMs) {
  const ageMs = new Date() - new Date(call.createdAt);
  return {
    ageMs,
    isTimedOut: ageMs >= timeoutMs,
    timeoutIn: Math.max(0, timeoutMs - ageMs),
  };
}

function emitCallResponse(io, { callId, response, hostMessage, hostName }) {
  io.emit('call-response', {
    callId,
    hostMessage,
    hostName,
    response,
  });
}

function emitTargetedCallResponse(io, target, payload) {
  if (!target) return;
  io.to(target).emit('call-response', payload);
}

module.exports = {
  isSameId,
  isCallParticipant,
  isHostOwner,
  loadCallById,
  markCallResponded,
  appendCallMessage,
  toCallSummary,
  toTimedOutSummary,
  emitCallResponse,
  emitTargetedCallResponse,
};

