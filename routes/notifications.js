const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/notifications - auth required. Most recent first, capped at 30.
router.get('/notifications', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE username = ? ORDER BY created_at DESC LIMIT 30').all(req.user.username);
  const unreadCount = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE username = ? AND read_at IS NULL').get(req.user.username).c;
  res.json({
    notifications: rows.map(n => ({
      id: n.id, type: n.type, message: n.message, link: n.link,
      read: !!n.read_at, createdAt: n.created_at,
    })),
    unreadCount,
  });
});

// POST /api/notifications/:id/read - auth required, only your own notification
router.post('/notifications/:id/read', requireAuth, (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!n || n.username !== req.user.username) return res.status(404).json({ error: 'Notification not found.' });
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(Date.now(), n.id);
  res.json({ ok: true });
});

// POST /api/notifications/read-all - auth required
router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE username = ? AND read_at IS NULL').run(Date.now(), req.user.username);
  res.json({ ok: true });
});

module.exports = router;
