const express = require('express');
const { db, slugify, normalizeTags, setArticleTags, getArticleTags, toIndexRow, resolveCategory } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

const router = express.Router();

function excerptOf(body) {
  return body.replace(/[#>*`\-]/g, '').trim().slice(0, 140) + (body.length > 140 ? '...' : '');
}

// GET /api/articles - index for the home/browse view
router.get('/articles', (req, res) => {
  const rows = db.prepare('SELECT * FROM articles ORDER BY updated_at DESC').all();
  res.json({ articles: rows.map(toIndexRow) });
});

// GET /api/articles/:slug - full article + revision list (metadata only, not full bodies)
router.get('/articles/:slug', (req, res) => {
  const a = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const revisions = db.prepare(
    'SELECT id, editor, created_at AS timestamp FROM revisions WHERE article_id = ? ORDER BY created_at ASC'
  ).all(a.id);
  const isBookmarked = req.user
    ? !!db.prepare('SELECT 1 FROM bookmarks WHERE username = ? AND article_slug = ?').get(req.user.username, a.slug)
    : false;
  const helpful = db.prepare("SELECT COUNT(*) AS c FROM article_votes WHERE article_id = ? AND vote = 1").get(a.id).c;
  const notHelpful = db.prepare("SELECT COUNT(*) AS c FROM article_votes WHERE article_id = ? AND vote = -1").get(a.id).c;
  const myVoteRow = req.user
    ? db.prepare('SELECT vote FROM article_votes WHERE username = ? AND article_id = ?').get(req.user.username, a.id)
    : null;
  res.json({
    article: {
      slug: a.slug, title: a.title, category: a.category, body: a.body,
      createdBy: a.created_by, createdAt: a.created_at,
      updatedBy: a.updated_by, updatedAt: a.updated_at,
      locked: !!a.locked,
      tags: getArticleTags(a.id),
      isBookmarked,
      helpful, notHelpful, myVote: myVoteRow ? myVoteRow.vote : 0,
      revisions,
    },
  });
});

// POST /api/articles/:slug/vote - auth required. vote: 1 (helpful), -1 (not helpful), 0 (remove vote)
router.post('/articles/:slug/vote', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const vote = Number((req.body || {}).vote);
  if (![1, -1, 0].includes(vote)) return res.status(400).json({ error: 'Invalid vote.' });
  if (vote === 0) {
    db.prepare('DELETE FROM article_votes WHERE username = ? AND article_id = ?').run(req.user.username, a.id);
  } else {
    db.prepare(`INSERT INTO article_votes (username, article_id, vote, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(username, article_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`)
      .run(req.user.username, a.id, vote, Date.now());
  }
  const helpful = db.prepare("SELECT COUNT(*) AS c FROM article_votes WHERE article_id = ? AND vote = 1").get(a.id).c;
  const notHelpful = db.prepare("SELECT COUNT(*) AS c FROM article_votes WHERE article_id = ? AND vote = -1").get(a.id).c;
  res.json({ helpful, notHelpful, myVote: vote });
});

// POST /api/articles - create a new article (auth required)
router.post('/articles', requireAuth, (req, res) => {
  const { title, category, newCategoryLabel, body, tags } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }
  const resolvedCategory = resolveCategory(category, newCategoryLabel);
  if (!resolvedCategory) return res.status(400).json({ error: 'Invalid category.' });
  if (title.length > 200) return res.status(400).json({ error: 'Title is too long.' });
  if (body.length > 50000) return res.status(400).json({ error: 'Article body is too long.' });
  const tagList = normalizeTags(tags);

  let slug = slugify(title);
  const existsStmt = db.prepare('SELECT 1 FROM articles WHERE slug = ?');
  let n = 2;
  while (existsStmt.get(slug)) { slug = `${slugify(title)}-${n}`; n++; }

  if (!req.user.isTrusted) {
    const now = Date.now();
    const info = db.prepare(`INSERT INTO pending_submissions (type, article_slug, title, category, body, author, created_at, tags)
      VALUES ('new_article', NULL, ?, ?, ?, ?, ?, ?)`).run(title.trim(), resolvedCategory, body, req.user.username, now, JSON.stringify(tagList));
    return res.status(202).json({ pending: true, pendingId: info.lastInsertRowid });
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO articles (slug, title, category, body, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, title.trim(), resolvedCategory, body, req.user.username, now, req.user.username, now);
    db.prepare('INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)')
      .run(info.lastInsertRowid, body, req.user.username, now);
    setArticleTags(info.lastInsertRowid, tagList);
  });
  tx();
  res.status(201).json({ slug });
});

// PUT /api/articles/:slug - edit an article (auth required; blocked if locked and not an admin)
router.put('/articles/:slug', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  if (a.locked && !req.user.isAdmin) {
    return res.status(403).json({ error: 'This article is locked by an admin and cannot be edited right now.' });
  }
  const { title, category, newCategoryLabel, body, tags } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }
  const resolvedCategory = resolveCategory(category, newCategoryLabel);
  if (!resolvedCategory) return res.status(400).json({ error: 'Invalid category.' });
  if (title.length > 200) return res.status(400).json({ error: 'Title is too long.' });
  if (body.length > 50000) return res.status(400).json({ error: 'Article body is too long.' });
  const tagList = normalizeTags(tags);

  if (!req.user.isTrusted) {
    const now = Date.now();
    const info = db.prepare(`INSERT INTO pending_submissions (type, article_slug, title, category, body, author, created_at, tags)
      VALUES ('edit', ?, ?, ?, ?, ?, ?, ?)`).run(a.slug, title.trim(), resolvedCategory, body, req.user.username, now, JSON.stringify(tagList));
    return res.status(202).json({ pending: true, pendingId: info.lastInsertRowid });
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE articles SET title=?, category=?, body=?, updated_by=?, updated_at=? WHERE id=?')
      .run(title.trim(), resolvedCategory, body, req.user.username, now, a.id);
    db.prepare('INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)')
      .run(a.id, body, req.user.username, now);
    setArticleTags(a.id, tagList);
  });
  tx();
  res.json({ ok: true });
});

// PUT /api/articles/:slug/lock - admin only, toggles edit-protection on a page
router.put('/articles/:slug/lock', requireAdmin, (req, res) => {
  const a = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const locked = !!(req.body || {}).locked;
  db.prepare('UPDATE articles SET locked = ? WHERE id = ?').run(locked ? 1 : 0, a.id);
  res.json({ ok: true, locked });
});

// POST /api/articles/:slug/restore/:revisionId - restore an older revision (blocked if locked and not admin)
// GET /api/articles/:slug/revisions/:revisionId - full body of one past revision (for diffing)
router.get('/articles/:slug/revisions/:revisionId', (req, res) => {
  const a = db.prepare('SELECT id FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const rev = db.prepare('SELECT id, body, editor, created_at AS timestamp FROM revisions WHERE id = ? AND article_id = ?').get(req.params.revisionId, a.id);
  if (!rev) return res.status(404).json({ error: 'Revision not found.' });
  res.json({ revision: rev });
});

router.post('/articles/:slug/restore/:revisionId', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  if (a.locked && !req.user.isAdmin) {
    return res.status(403).json({ error: 'This article is locked by an admin and cannot be edited right now.' });
  }
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ? AND article_id = ?').get(req.params.revisionId, a.id);
  if (!rev) return res.status(404).json({ error: 'Revision not found.' });

  if (!req.user.isTrusted) {
    const now = Date.now();
    const info = db.prepare(`INSERT INTO pending_submissions (type, article_slug, title, category, body, author, created_at)
      VALUES ('edit', ?, ?, ?, ?, ?, ?)`).run(a.slug, a.title, a.category, rev.body, req.user.username, now);
    return res.status(202).json({ pending: true, pendingId: info.lastInsertRowid });
  }

  const now = Date.now();
  const editor = `${req.user.username} (restored)`;
  const tx = db.transaction(() => {
    db.prepare('UPDATE articles SET body=?, updated_by=?, updated_at=? WHERE id=?')
      .run(rev.body, req.user.username, now, a.id);
    db.prepare('INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)')
      .run(a.id, rev.body, editor, now);
  });
  tx();
  res.json({ ok: true });
});

// GET /api/articles/:slug/comments
router.get('/articles/:slug/comments', (req, res) => {
  const a = db.prepare('SELECT id FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const rows = db.prepare(
    'SELECT id, author, body, parent_id AS parentId, created_at AS timestamp, deleted_at AS deletedAt FROM comments WHERE article_id = ? ORDER BY created_at ASC'
  ).all(a.id);
  const comments = rows.map(c => c.deletedAt
    ? { id: c.id, author: null, body: null, parentId: c.parentId, timestamp: c.timestamp, deleted: true }
    : { id: c.id, author: c.author, body: c.body, parentId: c.parentId, timestamp: c.timestamp, deleted: false }
  );
  res.json({ comments });
});

// POST /api/articles/:slug/comments (auth required) - optional parentId to reply to another comment
router.post('/articles/:slug/comments', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const { body, parentId } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'Comment text is required.' });
  if (body.length > 4000) return res.status(400).json({ error: 'Comment is too long.' });

  let parent = null;
  if (parentId !== undefined && parentId !== null) {
    parent = db.prepare('SELECT * FROM comments WHERE id = ? AND article_id = ?').get(parentId, a.id);
    if (!parent) return res.status(400).json({ error: 'The comment you are replying to no longer exists.' });
  }

  const now = Date.now();
  const info = db.prepare('INSERT INTO comments (article_id, author, body, parent_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(a.id, req.user.username, body.trim(), parent ? parent.id : null, now);

  // Notify anyone @mentioned in the comment (real users only, not the author themselves).
  const articleRow = db.prepare('SELECT slug, title FROM articles WHERE id = ?').get(a.id);
  const notified = new Set([req.user.username]);
  const mentionMatches = [...body.matchAll(/@([a-zA-Z0-9_-]{3,24})/g)].map(m => m[1]);
  const notify = db.prepare('INSERT INTO notifications (username, type, message, link, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const name of mentionMatches) {
    if (notified.has(name.toLowerCase())) continue;
    const user = db.prepare('SELECT username FROM users WHERE username_lower = ?').get(name.toLowerCase());
    if (!user) continue;
    notified.add(user.username.toLowerCase());
    notify.run(user.username, 'mention', `${req.user.username} mentioned you in a comment on "${articleRow.title}"`, articleRow.slug, now);
  }
  // Notify the parent comment's author that someone replied (if not already notified above).
  if (parent && !notified.has(parent.author.toLowerCase())) {
    notify.run(parent.author, 'reply', `${req.user.username} replied to your comment on "${articleRow.title}"`, articleRow.slug, now);
  }

  res.status(201).json({
    id: info.lastInsertRowid, author: req.user.username, body: body.trim(),
    parentId: parent ? parent.id : null, timestamp: now, deleted: false,
  });
});

// DELETE /api/comments/:id - soft delete: the comment's own author, OR an admin. Row + replies preserved.
router.delete('/comments/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  const isOwnComment = c.author === req.user.username;
  if (!isOwnComment && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only delete your own comments.' });
  }
  if (c.deleted_at) return res.status(200).json({ ok: true }); // already deleted, idempotent
  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(Date.now(), c.id);
  // Only count it as a moderation "removal" when an admin takes down someone else's
  // comment - a user deleting their own comment is normal use, not a strike against them.
  if (!isOwnComment) {
    db.prepare('UPDATE users SET comments_removed_count = comments_removed_count + 1 WHERE username = ?').run(c.author);
  }
  res.json({ ok: true });
});

// POST /api/articles/:slug/report - flag an article for admin attention (auth required)
router.post('/articles/:slug/report', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Please describe the issue.' });
  db.prepare('INSERT INTO reports (target_type, target_id, reason, reporter, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('article', a.id, reason, req.user.username, 'open', Date.now());
  res.status(201).json({ ok: true });
});

// POST /api/comments/:id/report - flag a comment for admin attention (auth required)
router.post('/comments/:id/report', requireAuth, (req, res) => {
  const c = db.prepare('SELECT id FROM comments WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Please describe the issue.' });
  db.prepare('INSERT INTO reports (target_type, target_id, reason, reporter, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('comment', c.id, reason, req.user.username, 'open', Date.now());
  res.status(201).json({ ok: true });
});

// POST /api/articles/:slug/bookmark - toggle a bookmark for the current user (auth required)
router.post('/articles/:slug/bookmark', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM articles WHERE slug = ?').get(req.params.slug);
  if (!a) return res.status(404).json({ error: 'Article not found.' });
  const existing = db.prepare('SELECT 1 FROM bookmarks WHERE username = ? AND article_slug = ?').get(req.user.username, req.params.slug);
  if (existing) {
    db.prepare('DELETE FROM bookmarks WHERE username = ? AND article_slug = ?').run(req.user.username, req.params.slug);
    return res.json({ bookmarked: false });
  }
  db.prepare('INSERT INTO bookmarks (username, article_slug, created_at) VALUES (?, ?, ?)').run(req.user.username, req.params.slug, Date.now());
  res.json({ bookmarked: true });
});

// GET /api/bookmarks - the current user's bookmarked articles (auth required)
router.get('/bookmarks', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.* FROM bookmarks b JOIN articles a ON a.slug = b.article_slug
    WHERE b.username = ? ORDER BY b.created_at DESC
  `).all(req.user.username);
  res.json({ articles: rows.map(toIndexRow) });
});

module.exports = router;
