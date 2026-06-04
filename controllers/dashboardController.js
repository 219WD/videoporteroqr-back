const User = require('../models/User');
const AnonymousConversation = require('../models/AnonymousConversation');

async function getAdminHosts(req, res) {
  try {
    const hosts = await User.find({ role: 'host' }).select('name email qrCode createdAt');
    res.json(hosts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching hosts' });
  }
}

async function getAdminUsers(req, res) {
  try {
    const users = await User.find({}).select('name email qrCode role createdAt').sort({ createdAt: -1 });

    res.json(
      users.map((user) => ({
        id: user._id,
        name: user.name,
        email: user.email,
        qrCode: user.qrCode || null,
        role: user.role || 'host',
        createdAt: user.createdAt,
      })),
    );
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching users' });
  }
}

async function getAdminGuests(req, res) {
  try {
    const guests = await User.find({ role: 'host' }).select('name email createdAt');

    res.json(
      guests.map((guest) => ({
        id: guest._id,
        name: guest.name,
        email: guest.email,
        createdAt: guest.createdAt,
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
    const totalConversations = await AnonymousConversation.countDocuments();
    const answeredConversations = await AnonymousConversation.countDocuments({ status: 'answered' });

    const activeHosts = await AnonymousConversation.aggregate([
      {
        $group: {
          _id: '$hostId',
          conversationCount: { $sum: 1 },
        },
      },
      {
        $sort: { conversationCount: -1 },
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
        conversations: totalConversations,
        answeredConversations,
        answerRate: totalConversations > 0 ? ((answeredConversations / totalConversations) * 100).toFixed(1) : 0,
      },
      activeHosts: activeHosts.map((item) => ({
        host: item.host[0],
        conversationCount: item.conversationCount,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching statistics' });
  }
}

module.exports = {
  getAdminHosts,
  getAdminUsers,
  getAdminGuests,
  getAdminStats,
};
