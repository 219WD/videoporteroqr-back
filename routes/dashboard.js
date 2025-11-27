const express = require('express');
const router = express.Router();
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');
const { authMiddleware, roleGuard } = require('../middleware/auth');

/**
 * Host: get guests that belong to this host
 * GET /dashboard/host/guests
 */
router.get('/host/guests', authMiddleware, roleGuard('host'), async (req, res) => {
  try {
    const guests = await User.find({ hostRef: req.user._id, role: 'guest' }).select('name email createdAt');
    res.json(guests);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error fetching guests' });
  }
});

/**
 * Admin: list all hosts
 * GET /dashboard/admin/hosts
 */
router.get('/admin/hosts', authMiddleware, roleGuard('admin'), async (req, res) => {
  try {
    const hosts = await User.find({ role: 'host' }).select('name email qrCode createdAt');
    res.json(hosts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error fetching hosts' });
  }
});

/**
 * Admin: list all guests (optionally filter by hostId query param)
 * GET /dashboard/admin/guests?hostId=...
 */
router.get('/admin/guests', authMiddleware, roleGuard('admin'), async (req, res) => {
  try {
    const { hostId } = req.query;
    const filter = { role: 'guest' };
    if (hostId) filter.hostRef = hostId;
    const guests = await User.find(filter).populate('hostRef', 'name email').select('name email createdAt hostRef');
    res.json(guests);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error fetching guests' });
  }
});

// routes/dashboard.js - Añade endpoints de estadísticas
/**
 * Get dashboard statistics for admin
 * GET /dashboard/admin/stats
 */
router.get('/admin/stats', authMiddleware, roleGuard('admin'), async (req, res) => {
  try {
    const totalHosts = await User.countDocuments({ role: 'host' });
    const totalGuests = await User.countDocuments({ role: 'guest' });
    const totalCalls = await DoorbellCall.countDocuments();
    const answeredCalls = await DoorbellCall.countDocuments({ status: 'answered' });
    
    // Hosts con más actividad
    const activeHosts = await DoorbellCall.aggregate([
      {
        $group: {
          _id: '$hostId',
          callCount: { $sum: 1 }
        }
      },
      {
        $sort: { callCount: -1 }
      },
      {
        $limit: 5
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'host'
        }
      }
    ]);

    res.json({
      totals: {
        hosts: totalHosts,
        guests: totalGuests,
        calls: totalCalls,
        answeredCalls: answeredCalls,
        answerRate: totalCalls > 0 ? (answeredCalls / totalCalls * 100).toFixed(1) : 0
      },
      activeHosts: activeHosts.map(item => ({
        host: item.host[0],
        callCount: item.callCount
      }))
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error fetching statistics' });
  }
});

module.exports = router;
