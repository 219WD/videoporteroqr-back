
function createSocketHelpers(io, state) {
  function notifyHost(hostId, event, data) {
    const hostSocketId = state.hostRooms.get(hostId.toString());
    if (!hostSocketId) return false;

    io.to(hostSocketId).emit(event, data);
    return true;
  }

  function notifyUser(userId, event, data) {
    const userSocketId = state.userSocketMap.get(userId.toString());
    if (!userSocketId) return false;

    io.to(userSocketId).emit(event, data);
    return true;
  }

  function isHostOnline(hostId) {
    return state.hostRooms.has(hostId.toString());
  }

  function getServerStats() {
    return {
      callRooms: state.rooms.size,
      flowRooms: state.flowRooms.size,
      hostRooms: state.hostRooms.size,
      trackedCalls: state.callRooms.size,
      totalConnections: io.engine.clientsCount,
      userConnections: state.userSocketMap.size,
    };
  }

  return {
    getServerStats,
    isHostOnline,
    notifyHost,
    notifyUser,
  };
}

module.exports = {
  createSocketHelpers,
};