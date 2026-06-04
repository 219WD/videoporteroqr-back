function createWebSocketStats() {
  let totalConnections = 0;
  let disconnects = 0;

  return {
    trackConnect() {
      totalConnections += 1;
    },
    trackDisconnect() {
      disconnects += 1;
    },
    snapshot(extra = {}) {
      return {
        activeConnections: extra.activeConnections || 0,
        totalConnections,
        disconnects,
      };
    },
  };
}

module.exports = {
  createWebSocketStats,
};
