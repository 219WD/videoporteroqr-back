
const User = require('../models/User');
const DoorbellCall = require('../models/DoorbellCall');

async function getHostGuests(req, res) {
  try {
    const host = await User.findById(req.user._id)
      .populate('guests.guestId', 'name email createdAt')
      .select('guests');

    const guests = (host?.guests || []).map((entry) => ({
      id: entry.guestId?._id || entry.guestId || null,
      name: entry.name || entry.guestId?.name || '',
      email: entry.guestId?.email || null,
      createdAt: entry.linkedAt || entry.guestId?.createdAt || null,
    }));

    res.json(guests);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching linked users' });
  }
}

async function getAdminHosts(req, res) {
  try {
    const hosts = await User.find({ role: 'host' }).select('name email qrCode createdAt');
    res.json(hosts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching hosts' });
  }
}

async function getAdminGuests(req, res) {
  try {
    const { hostId } = req.query;
    const filter = { role: 'host' };
    if (hostId) filter['hostRefs.hostId'] = hostId;
    const guests = await User.find(filter)
      .populate('hostRefs.hostId', 'name email')
      .select('name email createdAt hostRefs');

    res.json(
      guests.map((guest) => ({
        id: guest._id,
        name: guest.name,
        email: guest.email,
        createdAt: guest.createdAt,
        hostRefs: (guest.hostRefs || []).map((entry) => ({
          id: entry.hostId?._id || entry.hostId || null,
          name: entry.name || entry.hostId?.name || '',
          email: entry.hostId?.email || null,
          linkedAt: entry.linkedAt || null,
        })),
      })),
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching users' });
  }
}

async function getAdminStats(req, res) {
  try {
    const totalHosts = await User.countDocuments({ role: 'host' });
    const totalUsers = await User.countDocuments({ role: 'host' });
    const totalCalls = await DoorbellCall.countDocuments();
    const answeredCalls = await DoorbellCall.countDocuments({ status: 'answered' });

    const activeHosts = await DoorbellCall.aggregate([
      {
        $group: {
          _id: '$hostId',
          callCount: { $sum: 1 },
        },
      },
      {
        $sort: { callCount: -1 },
      },
      {
        $limit: 5,
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'host',
        },
      },
    ]);

    res.json({
      totals: {
        hosts: totalHosts,
        guests: totalUsers,
        calls: totalCalls,
        answeredCalls,
        answerRate: totalCalls > 0 ? ((answeredCalls / totalCalls) * 100).toFixed(1) : 0,
      },
      activeHosts: activeHosts.map((item) => ({
        host: item.host[0],
        callCount: item.callCount,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching statistics' });
  }
}

module.exports = {
  getHostGuests,
  getAdminHosts,
  getAdminGuests,
  getAdminStats,
};  