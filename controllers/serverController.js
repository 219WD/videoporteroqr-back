
const { getServerStats } = require('../websocket-server');

function getStats(req, res) {
  return res.json({
    success: true,
    stats: getServerStats(),
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  getStats,
};
