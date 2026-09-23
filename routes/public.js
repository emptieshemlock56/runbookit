const express = require('express');
const { db, toIndexRow } = require('../db');

const router = express.Router();

// GET /api/config - public, non-sensitive runtime config the frontend needs.
// The Turnstile SITE key is meant to be public (unlike the secret key); it's null
// until TURNSTILE_SITE_KEY is set, and the frontend just skips the CAPTCHA widget then.
router.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null });
});

// GET /api/categories - every category, in the order they were created
router.get('/categories', (req, res) => {
  const rows = db.prepare('SELECT slug, label FROM categories ORDER BY created_at ASC').all();
  res.json({ categories: rows });
});

// GET /api/search?q=... - real full-text search across title + body (FTS5).
// Logs any query that comes back with zero results so admins can see what's missing.
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  let rows = [];
  try {
    // Quote the query and escape internal quotes so punctuation in searches
    // (e.g. "firewall/vpn") can't break FTS5's query syntax.
    const ftsQuery = '"' + q.replace(/"/g, '""') + '"';
    rows = db.prepare(`
      SELECT a.*, bm25(articles_fts) AS rank
      FROM articles_fts
      JOIN articles a ON a.id = articles_fts.rowid
      WHERE articles_fts MATCH ?
      ORDER BY rank LIMIT 25
    `).all(ftsQuery);
  } catch (e) {
    rows = []; // malformed query - treat as no results rather than erroring
  }
  db.prepare('INSERT INTO search_log (query, results_count, created_at) VALUES (?, ?, ?)')
    .run(q, rows.length, Date.now());
  res.json({
    results: rows.map(toIndexRow),
  });
});

// GET /api/users/:username/profile - public contributor profile (no sensitive fields)
router.get('/users/:username/profile', (req, res) => {
  const u = db.prepare('SELECT username, is_admin, created_at FROM users WHERE username_lower = ?')
    .get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const articles = db.prepare('SELECT slug, title, updated_at FROM articles WHERE created_by = ? ORDER BY created_at DESC').all(u.username);
  const editCount = db.prepare('SELECT COUNT(*) AS c FROM revisions WHERE editor = ?').get(u.username).c;
  const commentCount = db.prepare('SELECT COUNT(*) AS c FROM comments WHERE author = ? AND deleted_at IS NULL').get(u.username).c;
  res.json({
    profile: {
      username: u.username, isAdmin: !!u.is_admin, joinedAt: u.created_at,
      articles: articles.map(a => ({ slug: a.slug, title: a.title, updatedAt: a.updated_at })),
      editsMade: editCount, commentsPosted: commentCount,
    },
  });
});

// GET /api/leaderboard - top contributors by articles + edits
router.get('/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username,
      (SELECT COUNT(*) FROM articles WHERE created_by = u.username) AS articles,
      (SELECT COUNT(*) FROM revisions WHERE editor = u.username) AS edits
    FROM users u WHERE u.banned = 0
  `).all();
  const ranked = rows.map(r => ({ ...r, score: r.articles + r.edits }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  res.json({ leaderboard: ranked });
});

module.exports = router;
