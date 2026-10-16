const conversationPresence = new Map();

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function registerConversationPresence({ socketId, conversationId, userId, role }) {
  const socket = clean(socketId);
  const conversation = clean(conversationId);
  const user = clean(userId);
  if (!socket || !conversation || !user || role !== 'host') return;
  const entries = conversationPresence.get(conversation) || new Map();
  entries.set(socket, user);
  conversationPresence.set(conversation, entries);
}

function unregisterConversationPresence({ socketId, conversationId }) {
  const socket = clean(socketId);
  const conversation = clean(conversationId);
  const entries = conversationPresence.get(conversation);
  if (!socket || !conversation || !entries) return;
  entries.delete(socket);
  if (entries.size === 0) conversationPresence.delete(conversation);
}

function hasHostPresence({ conversationId, hostId }) {
  const entries = conversationPresence.get(clean(conversationId));
  const host = clean(hostId);
  return Boolean(entries && host && Array.from(entries.values()).some((userId) => userId === host));
}

module.exports = {
  hasHostPresence,
  registerConversationPresence,
  unregisterConversationPresence,
};
