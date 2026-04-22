
function createSocketState() {
  return {
    callRooms: new Map(),
    flowRooms: new Map(),
    hostRooms: new Map(),
    rooms: new Map(),
    userSocketMap: new Map(),
  };
}

module.exports = {
  createSocketState,
};
