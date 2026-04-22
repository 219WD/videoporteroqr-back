
function asyncHandler(handler) {
  return function asyncRouteHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sendSuccess(res, data = {}, status = 200) {
  return res.status(status).json({
    success: true,
    ...data,
  });
}

function sendError(res, status, error, extra = {}) {
  return res.status(status).json({
    success: false,
    error,
    ...extra,
  });
}

module.exports = {
  asyncHandler,
  sendSuccess,
  sendError,
};

