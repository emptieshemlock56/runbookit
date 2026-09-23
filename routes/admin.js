const express = require('express');
const { db, slugify, setArticleTags } = require('../db');
const { requireAdmin } = require('../auth');
const backup = require('../backup');

const router = express.Router();

// GET /api/admin/pending - admin only. New-account submissions awaiting review.
router.get('/pending', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM pending_submissions ORDER BY created_at ASC').all();
  res.json({
    pending: rows.map(p => ({
      id: p.id, type: p.type, articleSlug: p.article_slug,
      title: p.title, category: p.category, body: p.body,
      author: p.author, createdAt: p.created_at,
    })),
  });
});

// POST /api/admin/pending/:id/approve - admin only. Publishes the submission and
// marks the author as trusted, so their future contributions go live immediately.
router.post('/pending/:id/approve', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM pending_submissions WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Submission not found (it may already have been resolved).' });

  const now = Date.now();
  const tx = db.transaction(() => {
    let articleId;
    if (p.type === 'new_article') {
      let slug = slugify(p.title);
      const existsStmt = db.prepare('SELECT 1 FROM articles WHERE slug = ?');
      let n = 2;
      while (existsStmt.get(slug)) { slug = `${slugify(p.title)}-${n}`; n++; }
      const info = db.prepare(`INSERT INTO articles (slug, title, category, body, created_by, created_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, p.title, p.category, p.body, p.author, now, p.author, now);
      db.prepare('INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, p.body, p.author, now);
      articleId = info.lastInsertRowid;
    } else {
      const a = db.prepare('SELECT * FROM articles WHERE slug = ?').get(p.article_slug);
      if (!a) throw new Error('The article this edit was submitted for no longer exists.');
      db.prepare('UPDATE articles SET title=?, category=?, body=?, updated_by=?, updated_at=? WHERE id=?')
        .run(p.title, p.category, p.body, p.author, now, a.id);
      db.prepare('INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)')
        .run(a.id, p.body, p.author, now);
      articleId = a.id;
    }
    let tagList = [];
    try { tagList = JSON.parse(p.tags || '[]'); } catch (e) { tagList = []; }
    if (Array.isArray(tagList) && tagList.length) setArticleTags(articleId, tagList);
    db.prepare('UPDATE users SET trusted = 1 WHERE username = ?').run(p.author);
    db.prepare('DELETE FROM pending_submissions WHERE id = ?').run(p.id);
  });
  try{ tx(); }catch(e){ return res.status(409).json({ error: e.message }); }
  res.json({ ok: true });
});

// POST /api/admin/pending/:id/reject - admin only. Discards the submission, no changes applied.
router.post('/pending/:id/reject', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM pending_submissions WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Submission not found (it may already have been resolved).' });
  db.prepare('UPDATE users SET rejected_count = rejected_count + 1 WHERE username = ?').run(p.author);
  db.prepare('DELETE FROM pending_submissions WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// GET /api/admin/users - admin only. Full account list with basic activity counts.
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, is_admin, banned, trusted, rejected_count, comments_removed_count, created_at FROM users ORDER BY created_at ASC').all();
  const articleCount = db.prepare('SELECT COUNT(*) AS c FROM articles WHERE created_by = ?');
  const editCount = db.prepare('SELECT COUNT(*) AS c FROM revisions WHERE editor = ?');
  const commentCount = db.prepare("SELECT COUNT(*) AS c FROM comments WHERE author = ? AND deleted_at IS NULL");
  res.json({
    users: users.map(u => ({
      username: u.username,
      isAdmin: !!u.is_admin,
      banned: !!u.banned,
      isTrusted: !!u.is_admin || !!u.trusted,
      createdAt: u.created_at,
      articlesCreated: articleCount.get(u.username).c,
      editsMade: editCount.get(u.username).c,
      commentsPosted: commentCount.get(u.username).c,
      rejectedCount: u.rejected_count,
      commentsRemoved: u.comments_removed_count,
    })),
  });
});

// POST /api/admin/promote/:username - admin only. Grants admin rights.
router.post('/promote/:username', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.banned) return res.status(400).json({ error: 'Unban this user before making them an admin.' });
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(target.id);
  res.json({ ok: true, username: target.username, isAdmin: true });
});

// POST /api/admin/demote/:username - admin only. Removes admin rights, but never the last admin (avoids lockout).
router.post('/demote/:username', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!target.is_admin) return res.status(200).json({ ok: true, username: target.username, isAdmin: false });
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
  if (adminCount <= 1) return res.status(400).json({ error: "Can't remove the last admin." });
  db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(target.id);
  res.json({ ok: true, username: target.username, isAdmin: false });
});

// POST /api/admin/ban/:username - admin only. Can't ban yourself or another admin (avoids lockouts/abuse).
router.post('/ban/:username', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.username === req.user.username) return res.status(400).json({ error: "You can't ban yourself." });
  if (target.is_admin) return res.status(400).json({ error: "Admins can't ban other admins." });
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(target.id);
  res.json({ ok: true, username: target.username, banned: true });
});

// POST /api/admin/unban/:username - admin only
router.post('/unban/:username', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username_lower = ?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found.' });
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(target.id);
  res.json({ ok: true, username: target.username, banned: false });
});

// GET /api/admin/reports - admin only. Open reports on articles/comments, with a preview of the target.
router.get('/reports', requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM reports WHERE status = 'open' ORDER BY created_at ASC").all();
  const withTargets = rows.map(r => {
    let target = null;
    if (r.target_type === 'article') {
      const a = db.prepare('SELECT slug, title FROM articles WHERE id = ?').get(r.target_id);
      target = a ? { slug: a.slug, title: a.title } : null;
    } else {
      const c = db.prepare('SELECT id, article_id, author, body FROM comments WHERE id = ?').get(r.target_id);
      if (c) {
        const a = db.prepare('SELECT slug, title FROM articles WHERE id = ?').get(c.article_id);
        target = { commentId: c.id, author: c.author, body: c.body, articleSlug: a ? a.slug : null, articleTitle: a ? a.title : null };
      }
    }
    return {
      id: r.id, targetType: r.target_type, reason: r.reason, reporter: r.reporter,
      createdAt: r.created_at, target,
    };
  });
  res.json({ reports: withTargets });
});

// POST /api/admin/reports/:id/dismiss - admin only. Marks the report handled; take any
// actual action (delete comment, lock article, ban user) separately with the existing tools.
router.post('/reports/:id/dismiss', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Report not found.' });
  db.prepare("UPDATE reports SET status = 'dismissed' WHERE id = ?").run(r.id);
  res.json({ ok: true });
});

// GET /api/admin/backup-settings - admin only. Never returns the secret key itself.
router.get('/backup-settings', requireAdmin, (req, res) => {
  res.json({ settings: backup.getBackupConfig() });
});

// POST /api/admin/backup-settings - admin only. Access key/secret are optional on
// update - leave them blank to keep whatever was saved before.
router.post('/backup-settings', requireAdmin, (req, res) => {
  const { bucket, region, accessKeyId, secretAccessKey, autoEnabled } = req.body || {};
  if (bucket !== undefined && typeof bucket !== 'string') return res.status(400).json({ error: 'Invalid bucket.' });
  if (region !== undefined && typeof region !== 'string') return res.status(400).json({ error: 'Invalid region.' });
  backup.saveBackupConfig({ bucket, region, accessKeyId, secretAccessKey, autoEnabled });
  res.json({ settings: backup.getBackupConfig() });
});

// POST /api/admin/backup-now - admin only. Runs a backup immediately and reports the result.
router.post('/backup-now', requireAdmin, async (req, res) => {
  try {
    const result = await backup.runBackup();
    res.json({ ok: true, result, settings: backup.getBackupConfig() });
  } catch (err) {
    res.status(400).json({ error: err.message, settings: backup.getBackupConfig() });
  }
});

module.exports = router;
