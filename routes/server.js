
const express = require('express');
const { authMiddleware, roleGuard } = require('../middleware/auth');
const serverController = require('../controllers/serverController');

const router = express.Router();

router.get('/stats', authMiddleware, roleGuard('admin'), serverController.getStats);

module.exports = router;
