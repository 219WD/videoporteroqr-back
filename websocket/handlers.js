const {
  loadConversationState,
  notifyHostAboutChatStart,
  notifyHostAboutGuestMessage,
  roomForConversation,
  roomForHost,
  resolveHostFromConversation,
  startAnonymousChatSession,
  updateMessageDeliveryStatus,
  storeChatMessage,
} = require('./chatFlow');
const { CHAT_EVENTS } = require('./chatContract');
const AnonymousConversation = require('../models/AnonymousConversation');
const { createScopedLogger } = require('../utils/logger');

const log = createScopedLogger('websocket:handlers');

function getString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createSocketAbortController(socket) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Socket disconnected'));
    }
  };

  socket.once('disconnect', abort);

  return controller;
}

function createConnectionHandlers(socket, { io, onDisconnect } = {}) {
  const requestAbortController = createSocketAbortController(socket);
  socket.data.requestAbortController = requestAbortController;

  socket.on('host:join', (payload = {}) => {
    const hostId = getString(payload.hostId || payload.userId);

    if (!hostId) {
      return;
    }

    socket.data.role = 'host';
    socket.data.hostId = hostId;
    socket.join(roomForHost(hostId));
    log.info('host:join', { socketId: socket.id, hostId });
    socket.emit('host:joined', { hostId });
  });

  socket.on(CHAT_EVENTS.JOIN, async (payload = {}, ack) => {
    const conversationId = getString(payload.conversationId || payload.callId);
    const hostId = getString(payload.hostId || payload.userId);
    const guestName = getString(payload.guestName);
    const qrCode = getString(payload.qrCode);
    const role = getString(payload.role) || 'guest';

    if (!conversationId) {
      const error = { ok: false, error: 'conversationId requerido' };
      if (typeof ack === 'function') {
        ack(error);
      }
      return;
    }

    socket.data.conversationId = conversationId;
    socket.data.role = role;
    socket.data.hostId = hostId || socket.data.hostId || null;
    log.info('chat:join', {
      socketId: socket.id,
      conversationId,
      role,
      hostId: socket.data.hostId || null,
      qrCode: qrCode || null,
    });

    socket.join(roomForConversation(conversationId));
    if (hostId && role === 'host') {
      socket.join(roomForHost(hostId));
    }

    try {
      const state = await loadConversationState(conversationId, requestAbortController.signal);
      const host = await resolveHostFromConversation(state.conversation, requestAbortController.signal);
      const response = {
        ok: true,
        conversationId,
        room: roomForConversation(conversationId),
        hostRoom: hostId ? roomForHost(hostId) : null,
        host,
        ...state,
      };

      if (typeof ack === 'function') {
        ack(response);
      } else {
        socket.emit(CHAT_EVENTS.CONVERSATION_STATE, response);
      }
    } catch (error) {
      log.error('chat:join:error', { conversationId, error });
      const response = {
        ok: false,
        error: 'No pudimos abrir la conversación',
      };
      if (typeof ack === 'function') {
        ack(response);
      } else {
        socket.emit(CHAT_EVENTS.ERROR, response);
      }
    }
  });

  socket.on(CHAT_EVENTS.SESSION_START, async (payload = {}, ack) => {
    try {
      const result = await startAnonymousChatSession({
        qrCode: getString(payload.qrCode),
        guestName: getString(payload.guestName),
        initialMessage: getString(payload.initialMessage || payload.message),
        signal: requestAbortController.signal,
      });

      const conversationId = result?.conversationId || null;
      const broadcastPayload = {
        ok: true,
        conversationId,
        ...result,
      };

      if (conversationId) {
        io.to(roomForConversation(conversationId)).emit(CHAT_EVENTS.MESSAGE_NEW, {
          ok: true,
          conversation: result.conversation,
          message: result.message,
        });

        if (result?.conversation?.hostId) {
          io.to(roomForHost(result.conversation.hostId)).emit(CHAT_EVENTS.CONVERSATION_UPDATED, {
            ok: true,
            conversation: result.conversation,
            message: result.message,
          });
        }
      }

      void notifyHostAboutChatStart(result).catch((error) => {
        log.warn('chat:session:start:push:error', {
          conversationId,
          error,
        });
      });

      if (typeof ack === 'function') {
        ack(broadcastPayload);
      }
    } catch (error) {
      if (requestAbortController.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'No pudimos iniciar la conversación' });
        }
        return;
      }

      log.error('chat:session:start:error', {
        error,
        qrCode: getString(payload.qrCode) || null,
      });

      if (typeof ack === 'function') {
        ack({
          ok: false,
          error: error?.message || 'No pudimos iniciar la conversación',
        });
      }
    }
  });

  socket.on(CHAT_EVENTS.MESSAGE_SEND, async (payload = {}, ack) => {
    try {
      const result = await storeChatMessage({
        conversationId: payload.conversationId || payload.callId || socket.data.conversationId,
        hostId: payload.hostId || socket.data.hostId,
        guestName: payload.guestName,
        qrCode: payload.qrCode,
        sender: payload.sender || socket.data.role || 'guest',
        senderName: payload.senderName || payload.guestName || payload.hostName || 'Visitante',
        text: payload.text || payload.message,
        signal: requestAbortController.signal,
      });

      const broadcastPayload = {
        ok: true,
        conversation: result.conversation,
        message: result.message,
      };

      io.to(roomForConversation(result.conversation.conversationId)).emit(CHAT_EVENTS.MESSAGE_NEW, broadcastPayload);

      if (result.conversation.hostId) {
        io.to(roomForHost(result.conversation.hostId)).emit(CHAT_EVENTS.CONVERSATION_UPDATED, {
          ok: true,
          conversation: result.conversation,
          message: result.message,
        });
      }

      if (result.message.sender === 'guest') {
        void notifyHostAboutGuestMessage(result).catch((error) => {
          log.warn('chat:message:push:error', {
            conversationId: result.conversation.conversationId,
            error,
          });
        });
      }

      if (typeof ack === 'function') {
        ack(broadcastPayload);
      }
    } catch (error) {
      log.error('chat:message:send:error', {
        error,
        conversationId: payload.conversationId || payload.callId || socket.data.conversationId || null,
      });

      const response = {
        ok: false,
        error: 'No pudimos enviar el mensaje',
      };

      if (typeof ack === 'function') {
        ack(response);
      } else {
        socket.emit(CHAT_EVENTS.ERROR, response);
      }
    }
  });

  socket.on(CHAT_EVENTS.MESSAGE_DELIVERED, async (payload = {}, ack) => {
    const conversationId = getString(payload.conversationId || payload.callId || socket.data.conversationId);
    const messageId = getString(payload.messageId);

    try {
      const message = await updateMessageDeliveryStatus({
        conversationId,
        messageId,
        status: 'delivered',
        socketId: socket.id,
        signal: requestAbortController.signal,
      });

      if (!message) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'message_not_found' });
        }
        return;
      }

      const broadcastPayload = {
        ok: true,
        conversationId,
        message,
      };

      io.to(roomForConversation(conversationId)).emit(CHAT_EVENTS.MESSAGE_STATUS, broadcastPayload);

      const conversation = await loadConversationState(conversationId, requestAbortController.signal);
      if (conversation?.conversation?.hostId) {
        io.to(roomForHost(conversation.conversation.hostId)).emit(CHAT_EVENTS.MESSAGE_STATUS, broadcastPayload);
      }

      if (typeof ack === 'function') {
        ack(broadcastPayload);
      }
    } catch (error) {
      log.warn('chat:message:delivered:error', {
        conversationId,
        messageId,
        error,
      });
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'No pudimos registrar la entrega' });
      }
    }
  });

  socket.on(CHAT_EVENTS.MESSAGE_READ, async (payload = {}, ack) => {
    const conversationId = getString(payload.conversationId || payload.callId || socket.data.conversationId);
    const messageId = getString(payload.messageId);

    try {
      const message = await updateMessageDeliveryStatus({
        conversationId,
        messageId,
        status: 'read',
        socketId: socket.id,
        signal: requestAbortController.signal,
      });

      if (!message) {
        if (typeof ack === 'function') {
          ack({ ok: false, error: 'message_not_found' });
        }
        return;
      }

      const broadcastPayload = {
        ok: true,
        conversationId,
        message,
      };

      io.to(roomForConversation(conversationId)).emit(CHAT_EVENTS.MESSAGE_STATUS, broadcastPayload);

      const conversationDoc = await AnonymousConversation.findById(conversationId).setOptions({
        signal: requestAbortController.signal,
        maxTimeMS: 5000,
      });
      if (conversationDoc) {
        if (message?.sender === 'guest') {
          conversationDoc.hostUnreadCount = 0;
        }

        await conversationDoc.save(requestAbortController.signal ? { signal: requestAbortController.signal } : undefined);

        const conversationState = await loadConversationState(conversationId, requestAbortController.signal);
        if (conversationState?.conversation?.hostId) {
          io.to(roomForHost(conversationState.conversation.hostId)).emit(CHAT_EVENTS.MESSAGE_STATUS, broadcastPayload);
          io.to(roomForHost(conversationState.conversation.hostId)).emit(CHAT_EVENTS.CONVERSATION_UPDATED, {
            ok: true,
            conversation: conversationState.conversation,
            message: broadcastPayload.message,
          });
        }
      }

      if (typeof ack === 'function') {
        ack(broadcastPayload);
      }
    } catch (error) {
      log.warn('chat:message:read:error', {
        conversationId,
        messageId,
        error,
      });
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'No pudimos registrar la lectura' });
      }
    }
  });

  socket.on('disconnect', () => {
    log.info('disconnect', {
      socketId: socket.id,
      role: socket.data.role || null,
      hostId: socket.data.hostId || null,
      conversationId: socket.data.conversationId || null,
    });
    if (socket.data.requestAbortController && !socket.data.requestAbortController.signal.aborted) {
      socket.data.requestAbortController.abort(new Error('Socket disconnected'));
    }
    delete socket.data.requestAbortController;
    if (typeof onDisconnect === 'function') {
      onDisconnect();
    }
  });
}

module.exports = {
  createConnectionHandlers,
};
