const express = require('express');
const { db, ensureAdminExists } = require('../db');
const { hashPassword, verifyPassword, signToken, setSessionCookie, clearSessionCookie } = require('../auth');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;

function publicUser(row) {
  return { id: row.id, username: row.username, isAdmin: !!row.is_admin, isTrusted: !!row.is_admin || !!row.trusted };
}

router.post('/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-24 characters: letters, numbers, - or _ only.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const usernameLower = username.toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE username_lower = ?').get(usernameLower);
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users (username, username_lower, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, usernameLower, hash, Date.now());

  // First-ever account becomes admin automatically.
  ensureAdminExists();
  const row = db.prepare('SELECT id, username, is_admin, trusted FROM users WHERE id = ?').get(info.lastInsertRowid);
  setSessionCookie(res, signToken(row));
  res.json({ user: publicUser(row) });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const row = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(username.toLowerCase());
  if (!row) return res.status(401).json({ error: 'No account with that username.' });
  if (row.banned) return res.status(403).json({ error: 'This account has been suspended.' });
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });

  setSessionCookie(res, signToken(row));
  res.json({ user: publicUser(row) });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

module.exports = router;
