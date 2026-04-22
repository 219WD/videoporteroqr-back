
const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const DoorbellCall = require('../models/DoorbellCall');
const AnonymousConversation = require('../models/AnonymousConversation');
const {
  emitConversationMessage,
  emitConversationRead,
  emitConversationUpdate,
} = require('../websocket-server');
const { dispatchNotification } = require('../services/pushNotifications');

function chatLog(event, data = {}) {
  console.log(`[messages:${event}]`, data);
}

function toId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString();
  if (typeof value.toString === 'function') return value.toString();
  return null;
}

function buildPairKey(firstId, secondId) {
  return [toId(firstId), toId(secondId)]
    .filter(Boolean)
    .sort()
    .join(':');
}

function normalizeRelationshipList(user) {
  const contacts = new Map();

  const add = (entry, contactId, role, fallbackName) => {
    const id = toId(contactId);
    if (!id) return;

    const current = contacts.get(id) || {
      id,
      name: fallbackName || '',
      roles: [],
    };

    if (entry?.name && !current.name) {
      current.name = entry.name;
    }

    if (!current.roles.includes(role)) {
      current.roles.push(role);
    }

    contacts.set(id, current);
  };

  (user.guests || []).forEach((entry) => {
    add(entry, entry.guestId, 'guest', entry.name);
  });

  (user.hostRefs || []).forEach((entry) => {
    add(entry, entry.hostId, 'host', entry.name);
  });

  return [...contacts.values()];
}

function mergeContactRoles(targetMap, contactId, name, role) {
  const id = toId(contactId);
  if (!id) return;

  const current = targetMap.get(id) || {
    id,
    name: name || '',
    roles: [],
  };

  if (name && !current.name) {
    current.name = name;
  }

  if (!current.roles.includes(role)) {
    current.roles.push(role);
  }

  targetMap.set(id, current);
}

function mergeContactMaps(baseList, extraList) {
  const map = new Map();

  const append = (contact) => {
    const id = toId(contact?.id);
    if (!id) return;

    const current = map.get(id) || {
      id,
      name: contact.name || '',
      roles: [],
    };

    if (contact.name && !current.name) {
      current.name = contact.name;
    }

    (contact.roles || []).forEach((role) => {
      if (!current.roles.includes(role)) {
        current.roles.push(role);
      }
    });

    map.set(id, current);
  };

  [...baseList, ...extraList].forEach(append);
  return [...map.values()];
}

async function loadFallbackContacts(currentUser) {
  const userId = toId(currentUser?._id);
  if (!userId) return [];

  const relatedUsers = await User.find({
    $or: [
      { 'guests.guestId': currentUser._id },
      { 'hostRefs.hostId': currentUser._id },
    ],
  }).select('name email role guests hostRefs');

  const contacts = new Map();

  relatedUsers.forEach((otherUser) => {
    const otherUserId = toId(otherUser);
    if (!otherUserId || otherUserId === userId) return;

    const guestEntries = Array.isArray(otherUser.guests) ? otherUser.guests : [];
    const hostEntries = Array.isArray(otherUser.hostRefs) ? otherUser.hostRefs : [];

    const currentUserAppearsAsGuest = guestEntries.some((entry) => toId(entry.guestId) === userId);
    const currentUserAppearsAsHost = hostEntries.some((entry) => toId(entry.hostId) === userId);

    if (currentUserAppearsAsGuest) {
      mergeContactRoles(contacts, otherUserId, otherUser.name, 'host');
    }

    if (currentUserAppearsAsHost) {
      mergeContactRoles(contacts, otherUserId, otherUser.name, 'guest');
    }
  });

  return [...contacts.values()];
}

function formatMessage(message) {
  return {
    id: message?._id ? message._id.toString() : null,
    senderId: toId(message?.senderId),
    senderName: message?.senderName || '',
    text: message?.text || '',
    createdAt: message?.createdAt || null,
  };
}

function formatConversationBase(conversation, currentUserId, contactDoc) {
  const participants = Array.isArray(conversation.participantIds) ? conversation.participantIds : [];
  const otherParticipant = participants.find((participant) => toId(participant) !== currentUserId);
  const resolvedContact = contactDoc || otherParticipant;
  const participantStates = Array.isArray(conversation.participantStates) ? conversation.participantStates : [];
  const currentState = participantStates.find((state) => toId(state.userId) === currentUserId);

  return {
    id: conversation._id.toString(),
    conversationId: conversation._id.toString(),
    contact: resolvedContact ? {
      id: toId(resolvedContact),
      name: resolvedContact.name || '',
      email: resolvedContact.email || '',
      role: resolvedContact.role || 'host',
    } : null,
    lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt,
    lastMessageText: conversation.lastMessageText || null,
    lastMessageSenderId: toId(conversation.lastMessageSenderId),
    lastMessageSenderName: conversation.lastMessageSenderName || null,
    messageCount: conversation.messageCount || 0,
    unreadCount: currentState?.unreadCount || 0,
  };
}

function formatPagination(messages, hasMore) {
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  return {
    hasMore,
    nextCursor: lastMessage?.createdAt ? new Date(lastMessage.createdAt).getTime() : null,
  };
}

async function loadAllowedContactSet(user) {
  const normalized = normalizeRelationshipList(user);
  return new Set(normalized.map((contact) => contact.id));
}

async function loadContactDocs(contactIds) {
  if (!contactIds.length) return [];
  return User.find({ _id: { $in: contactIds } }).select('name email role createdAt');
}

async function loadConversationMap(userId) {
  const conversations = await Conversation.find({ participantIds: userId })
    .populate('participantIds', 'name email role')
    .sort({ lastMessageAt: -1, updatedAt: -1 });

  const map = new Map();
  conversations.forEach((conversation) => {
    const participants = Array.isArray(conversation.participantIds) ? conversation.participantIds : [];
    const otherParticipant = participants.find((participant) => toId(participant) !== toId(userId));
    if (otherParticipant) {
      map.set(toId(otherParticipant), conversation);
    }
  });

  return map;
}

async function getConversationWithContact(currentUserId, contactUserId) {
  const pairKey = buildPairKey(currentUserId, contactUserId);
  let conversation = await Conversation.findOne({ pairKey })
    .populate('participantIds', 'name email role');

  if (!conversation) {
    conversation = await Conversation.create({
      pairKey,
      participantIds: [currentUserId, contactUserId],
      participantStates: [
        { userId: currentUserId, lastReadAt: new Date(), unreadCount: 0 },
        { userId: contactUserId, lastReadAt: null, unreadCount: 0 },
      ],
      lastMessageAt: null,
      lastMessageText: null,
      lastMessageSenderId: null,
      lastMessageSenderName: null,
      messageCount: 0,
    });

    conversation = await Conversation.findById(conversation._id)
      .populate('participantIds', 'name email role');
  }

  return conversation;
}

async function migrateLegacyConversationIfNeeded(conversationId) {
  const conversation = await Conversation.findById(conversationId);
  if (!conversation || (conversation.messageCount || 0) > 0) {
    return;
  }

  const rawConversation = await Conversation.collection.findOne({
    _id: new mongoose.Types.ObjectId(conversationId),
  });

  const legacyMessages = Array.isArray(rawConversation?.messages) ? rawConversation.messages : [];
  if (legacyMessages.length === 0) {
    return;
  }

  const normalizedMessages = legacyMessages
    .filter((message) => message?.text)
    .map((message) => ({
      conversationId: conversation._id,
      senderId: message.senderId || conversation.participantIds[0],
      senderName: message.senderName || 'Usuario',
      text: message.text,
      createdAt: message.createdAt || new Date(),
    }));

  if (normalizedMessages.length === 0) {
    return;
  }

  await Message.insertMany(normalizedMessages, { ordered: true });

  const lastMessage = normalizedMessages[normalizedMessages.length - 1];
  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        lastMessageAt: lastMessage.createdAt,
        lastMessageText: lastMessage.text,
        lastMessageSenderId: lastMessage.senderId,
        lastMessageSenderName: lastMessage.senderName,
        messageCount: normalizedMessages.length,
        participantStates: (conversation.participantIds || []).map((participantId) => ({
          userId: participantId,
          lastReadAt: toId(participantId) === toId(lastMessage.senderId) ? lastMessage.createdAt : null,
          unreadCount: toId(participantId) === toId(lastMessage.senderId) ? 0 : normalizedMessages.length,
        })),
      },
      $unset: { messages: '' },
    },
  );
}

async function ensureParticipantStates(conversation) {
  if (!conversation) return conversation;

  const participantIds = Array.isArray(conversation.participantIds) ? conversation.participantIds : [];
  const participantStates = Array.isArray(conversation.participantStates) ? conversation.participantStates : [];
  const existingIds = new Set(participantStates.map((state) => toId(state.userId)));
  let changed = false;

  participantIds.forEach((participantId) => {
    const id = toId(participantId);
    if (!id || existingIds.has(id)) return;
    participantStates.push({
      userId: participantId,
      lastReadAt: null,
      unreadCount: 0,
    });
    changed = true;
  });

  if (changed) {
    conversation.participantStates = participantStates;
    await Conversation.updateOne({ _id: conversation._id }, { $set: { participantStates } });
  }

  return conversation;
}

async function markConversationRead(conversation, userId) {
  if (!conversation) return [];

  const now = new Date();
  const participantStates = Array.isArray(conversation.participantStates) ? conversation.participantStates : [];
  const nextStates = participantStates.map((state) => {
    if (toId(state.userId) !== toId(userId)) return state;
    return {
      ...state,
      lastReadAt: now,
      unreadCount: 0,
    };
  });

  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { participantStates: nextStates } },
  );

  conversation.participantStates = nextStates;
  return nextStates;
}

async function loadConversationMessages(conversationId, limit = 30, before = null) {
  const query = { conversationId };
  const beforeMs = Number(before);
  if (Number.isFinite(beforeMs) && beforeMs > 0) {
    query.createdAt = { $lt: new Date(beforeMs) };
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const messages = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(safeLimit + 1);

  const hasMore = messages.length > safeLimit;
  const sliced = hasMore ? messages.slice(0, safeLimit) : messages;

  return {
    messages: sliced.map(formatMessage),
    pagination: formatPagination(sliced, hasMore),
  };
}

async function getContacts(req, res) {
  try {
    chatLog('contacts:request', {
      userId: toId(req.user?._id),
      role: req.user?.role,
    });

    const directContacts = normalizeRelationshipList(req.user);
    const fallbackContacts = await loadFallbackContacts(req.user);
    const normalizedContacts = mergeContactMaps(directContacts, fallbackContacts);

    const contactIds = [...new Set(normalizedContacts.map((contact) => contact.id))];
    const [contactDocs, conversationMap] = await Promise.all([
      loadContactDocs(contactIds),
      loadConversationMap(req.user._id),
    ]);

    const contactDocMap = new Map(contactDocs.map((contact) => [toId(contact), contact]));

    const contacts = normalizedContacts
      .map((contact) => {
        const doc = contactDocMap.get(contact.id);
        const conversation = conversationMap.get(contact.id);
        const base = conversation ? formatConversationBase(conversation, toId(req.user._id), doc) : null;

        return {
          id: contact.id,
          name: doc?.name || contact.name || '',
          email: doc?.email || '',
          roleRelativeToMe: contact.roles.length > 1 ? 'both' : contact.roles[0] || 'guest',
          roles: contact.roles,
          conversationId: base?.conversationId || null,
          lastMessageAt: base?.lastMessageAt || null,
          lastMessagePreview: base?.lastMessageText || null,
        };
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    chatLog('contacts:response', {
      userId: toId(req.user?._id),
      totalContacts: contacts.length,
      contactIds: contacts.map((contact) => contact.id),
    });

    res.json({
      success: true,
      contacts,
    });
  } catch (error) {
    console.error('Error loading contacts:', error);
    res.status(500).json({ error: 'Error obteniendo contactos' });
  }
}

async function getConversations(req, res) {
  try {
    chatLog('conversations:request', {
      userId: toId(req.user?._id),
      role: req.user?.role,
    });

    const conversations = await Conversation.find({ participantIds: req.user._id })
      .populate('participantIds', 'name email role')
      .sort({ lastMessageAt: -1, updatedAt: -1 });

    chatLog('conversations:response', {
      userId: toId(req.user?._id),
      totalConversations: conversations.length,
      conversationIds: conversations.map((conversation) => conversation._id.toString()),
    });

    res.json({
      success: true,
      conversations: conversations.map((conversation) => formatConversationBase(conversation, toId(req.user._id))),
    });
  } catch (error) {
    console.error('Error loading conversations:', error);
    res.status(500).json({ error: 'Error obteniendo conversaciones' });
  }
}

async function getAnonymousConversations(req, res) {
  try {
    chatLog('anonymous:conversations:request', {
      userId: toId(req.user?._id),
      role: req.user?.role,
    });

    const legacyCalls = await DoorbellCall.find({
      hostId: req.user._id,
      actionType: { $in: ['message', 'call'] },
    }).lean();

    for (const call of legacyCalls) {
      await AnonymousConversation.findOneAndUpdate(
        { _id: call._id.toString() },
        {
          $set: {
            hostId: call.hostId,
            guestName: call.guestName || 'Visitante',
            qrCode: call.qrCode || '',
            actionType: call.actionType === 'call' ? 'call' : 'message',
            status: call.status || 'pending',
            response: call.response || null,
            messageCount: Array.isArray(call.messages) ? call.messages.length : 0,
            lastMessageAt: Array.isArray(call.messages) && call.messages.length > 0
              ? call.messages[call.messages.length - 1].timestamp || call.updatedAt || call.createdAt
              : call.updatedAt || call.createdAt,
            lastMessageText: Array.isArray(call.messages) && call.messages.length > 0
              ? call.messages[call.messages.length - 1].message || null
              : call.messageContent || null,
            lastMessageSender: Array.isArray(call.messages) && call.messages.length > 0
              ? call.messages[call.messages.length - 1].sender || null
              : null,
            isAnonymous: call.isAnonymous !== false,
            timeoutAt: call.timeoutAt || null,
            answeredAt: call.answeredAt || null,
          },
          $setOnInsert: {
            _id: call._id.toString(),
          },
        },
        { upsert: true, new: true },
      );
    }

    const conversations = await AnonymousConversation.find({ hostId: req.user._id })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .lean();

    const items = conversations.map((conversation) => ({
      id: conversation._id,
      callId: conversation._id,
      guestName: conversation.guestName || 'Visitante',
      actionType: conversation.actionType,
      status: conversation.status,
      response: conversation.response || null,
      lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt,
      lastMessageText: conversation.lastMessageText || conversation.messageContent || null,
      lastMessageSender: conversation.lastMessageSender || null,
      messageCount: conversation.messageCount || 0,
      hostUnreadCount: conversation.hostUnreadCount || 0,
      isAnonymous: conversation.isAnonymous !== false,
      createdAt: conversation.createdAt,
      answeredAt: conversation.answeredAt || null,
      timeoutAt: conversation.timeoutAt || null,
      qrCode: conversation.qrCode || null,
    }));

    chatLog('anonymous:conversations:response', {
      userId: toId(req.user?._id),
      totalConversations: items.length,
      callIds: items.map((item) => item.callId),
    });

    res.json({
      success: true,
      conversations: items,
    });
  } catch (error) {
    console.error('Error loading anonymous conversations:', error);
    res.status(500).json({ error: 'Error obteniendo conversaciones anónimas' });
  }
}

async function resolveConversation(req, res) {
  try {
    const contactUserId = req.body.contactUserId || req.body.userId;

    chatLog('resolve:request', {
      userId: toId(req.user?._id),
      contactUserId: contactUserId || null,
    });

    if (!contactUserId || !mongoose.isValidObjectId(contactUserId)) {
      return res.status(400).json({ error: 'Contacto requerido' });
    }

    if (toId(req.user._id) === toId(contactUserId)) {
      return res.status(400).json({ error: 'No puedes abrir un chat contigo mismo' });
    }

    const allowedContactSet = await loadAllowedContactSet(req.user);
    if (!allowedContactSet.has(toId(contactUserId))) {
      return res.status(403).json({ error: 'Ese usuario no está vinculado contigo' });
    }

    const contactDoc = await User.findById(contactUserId).select('name email role');
    const conversation = await getConversationWithContact(req.user._id, contactUserId);

    chatLog('resolve:response', {
      userId: toId(req.user?._id),
      contactUserId: toId(contactUserId),
      conversationId: conversation?._id?.toString?.() || null,
    });

    res.json({
      success: true,
      conversation: formatConversationBase(conversation, toId(req.user._id), contactDoc),
    });
  } catch (error) {
    console.error('Error resolving conversation:', error);
    res.status(500).json({ error: 'Error resolviendo conversación' });
  }
}

async function getConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const limit = req.query.limit || 30;
    const before = req.query.before || null;

    chatLog('conversation:get:request', {
      userId: toId(req.user?._id),
      conversationId,
      limit,
      before,
    });

    if (!mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({ error: 'Conversación inválida' });
    }

    const conversation = await Conversation.findById(conversationId)
      .populate('participantIds', 'name email role');

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const isParticipant = Array.isArray(conversation.participantIds)
      && conversation.participantIds.some((participant) => toId(participant) === toId(req.user._id));

    if (!isParticipant) {
      return res.status(403).json({ error: 'No tienes permisos para esta conversación' });
    }

    await migrateLegacyConversationIfNeeded(conversationId);
    await ensureParticipantStates(conversation);
    await markConversationRead(conversation, req.user._id);

    const refreshedConversation = await Conversation.findById(conversationId)
      .populate('participantIds', 'name email role');

    const page = await loadConversationMessages(conversationId, limit, before);

    chatLog('conversation:get:response', {
      userId: toId(req.user?._id),
      conversationId,
      messagesReturned: page.messages.length,
      hasMore: page.pagination?.hasMore || false,
      nextCursor: page.pagination?.nextCursor || null,
    });

    res.json({
      success: true,
      conversation: {
        ...formatConversationBase(refreshedConversation || conversation, toId(req.user._id)),
        messages: page.messages,
        pagination: page.pagination,
      },
    });
  } catch (error) {
    console.error('Error loading conversation:', error);
    res.status(500).json({ error: 'Error obteniendo conversación' });
  }
}

async function sendMessage(req, res) {
  try {
    const { conversationId } = req.params;
    const text = String(req.body.text || req.body.message || '').trim();

    chatLog('message:send:request', {
      userId: toId(req.user?._id),
      conversationId,
      messageLength: text.length,
    });

    if (!mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({ error: 'Conversación inválida' });
    }

    if (!text) {
      return res.status(400).json({ error: 'Mensaje requerido' });
    }

    const conversation = await Conversation.findById(conversationId)
      .populate('participantIds', 'name email role');

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const isParticipant = Array.isArray(conversation.participantIds)
      && conversation.participantIds.some((participant) => toId(participant) === toId(req.user._id));

    if (!isParticipant) {
      return res.status(403).json({ error: 'No tienes permisos para esta conversación' });
    }

    await migrateLegacyConversationIfNeeded(conversationId);
    await ensureParticipantStates(conversation);

    const messageDoc = await Message.create({
      conversationId: conversation._id,
      senderId: req.user._id,
      senderName: req.user.name,
      text,
    });

    const nextStates = (conversation.participantStates || []).map((state) => {
      if (toId(state.userId) === toId(req.user._id)) {
        return {
          ...state,
          lastReadAt: messageDoc.createdAt,
          unreadCount: 0,
        };
      }

      return {
        ...state,
        unreadCount: (state.unreadCount || 0) + 1,
      };
    });

    const otherParticipant = (conversation.participantIds || []).find((participant) => toId(participant) !== toId(req.user._id));

    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $set: {
          participantStates: nextStates,
          lastMessageAt: messageDoc.createdAt,
          lastMessageText: messageDoc.text,
          lastMessageSenderId: req.user._id,
          lastMessageSenderName: req.user.name,
        },
        $inc: { messageCount: 1 },
      },
    );

    const refreshedConversation = await Conversation.findById(conversationId)
      .populate('participantIds', 'name email role');

    const page = await loadConversationMessages(conversationId, 30);

    const conversationPayload = {
      ...formatConversationBase(refreshedConversation || conversation, toId(req.user._id)),
      messages: page.messages,
      pagination: page.pagination,
    };

    const messagePayload = formatMessage(messageDoc);

    chatLog('message:send:response', {
      userId: toId(req.user?._id),
      conversationId,
      messageId: messagePayload.id,
      otherParticipantId: toId(otherParticipant),
      unreadCounts: (nextStates || []).map((state) => ({
        userId: toId(state.userId),
        unreadCount: state.unreadCount || 0,
      })),
    });

    const recipientIds = [...new Set((conversation.participantIds || [])
      .map((participant) => toId(participant))
      .filter((participantId) => participantId && participantId !== toId(req.user._id)))];

    if (otherParticipant) {
      emitConversationMessage(otherParticipant._id || otherParticipant, {
        conversationId: conversation._id.toString(),
        message: messagePayload,
      });
      emitConversationUpdate(otherParticipant._id || otherParticipant, conversationPayload);
    }

    const pushResults = [];
    for (const recipientId of recipientIds) {
      // El push se envía por usuario para evitar depender de una referencia poblada concreta.
      // Así cubrimos chats con cualquier combinación de host/guest y múltiples dispositivos.
      const result = await dispatchNotification({
        userId: recipientId,
        socketEvent: 'conversation-message',
        sendSocket: false,
        title: req.user.name,
        body: text,
        payload: {
          conversationId: conversation._id.toString(),
          message: messagePayload,
          screen: '/messages/[conversationId]',
          params: { conversationId: conversation._id.toString() },
          type: 'message_received',
        },
        data: {
          type: 'message_received',
          conversationId: conversation._id.toString(),
          messageId: messagePayload.id,
          senderId: req.user._id.toString(),
          senderName: req.user.name,
          screen: '/messages/[conversationId]',
          params: { conversationId: conversation._id.toString() },
        },
      });

      pushResults.push({
        recipientId,
        ...result,
      });
    }

    if (pushResults.length > 0) {
      chatLog('message:push:response', {
        conversationId: conversation._id.toString(),
        senderId: toId(req.user._id),
        pushResults: pushResults.map((item) => ({
          recipientId: item.recipientId,
          notificationId: item.notificationId,
          delivered: item.pushResult?.delivered || false,
          tokenCount: item.pushResult?.tokenCount || 0,
        })),
      });
    }

    emitConversationUpdate(req.user._id, conversationPayload);

    res.json({
      success: true,
      conversation: conversationPayload,
      message: messagePayload,
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Error enviando mensaje' });
  }
}

async function markConversationReadHandler(req, res) {
  try {
    const { conversationId } = req.params;

    chatLog('conversation:read:request', {
      userId: toId(req.user?._id),
      conversationId,
    });

    if (!mongoose.isValidObjectId(conversationId)) {
      return res.status(400).json({ error: 'Conversación inválida' });
    }

    const conversation = await Conversation.findById(conversationId)
      .populate('participantIds', 'name email role');

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const isParticipant = Array.isArray(conversation.participantIds)
      && conversation.participantIds.some((participant) => toId(participant) === toId(req.user._id));

    if (!isParticipant) {
      return res.status(403).json({ error: 'No tienes permisos para esta conversaciÃ³n' });
    }

    await ensureParticipantStates(conversation);
    const participantStates = await markConversationRead(conversation, req.user._id);

    emitConversationRead(req.user._id, {
      conversationId: conversation._id.toString(),
      participantStates,
    });

    chatLog('conversation:read:response', {
      userId: toId(req.user?._id),
      conversationId: conversation._id.toString(),
      participantStates: participantStates.map((state) => ({
        userId: toId(state.userId),
        unreadCount: state.unreadCount || 0,
      })),
    });

    res.json({
      success: true,
      conversationId: conversation._id.toString(),
      participantStates,
    });
  } catch (error) {
    console.error('Error marking conversation read:', error);
    res.status(500).json({ error: 'Error marcando conversación como leída' });
  }
}

module.exports = {
  getContacts,
  getConversations,
  getAnonymousConversations,
  resolveConversation,
  getConversation,
  sendMessage,
  markConversationReadHandler,
};
