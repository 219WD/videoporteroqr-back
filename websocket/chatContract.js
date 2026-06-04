const CHAT_EVENTS = Object.freeze({
  JOIN: 'chat:join',
  SESSION_START: 'chat:session:start',
  MESSAGE_SEND: 'chat:message:send',
  CONVERSATION_STATE: 'chat:conversation:state',
  MESSAGE_NEW: 'chat:message:new',
  MESSAGE_STATUS: 'chat:message:status',
  MESSAGE_DELIVERED: 'chat:message:delivered',
  MESSAGE_READ: 'chat:message:read',
  CONVERSATION_UPDATED: 'chat:conversation:updated',
  ERROR: 'chat:error',
});

module.exports = {
  CHAT_EVENTS,
};
