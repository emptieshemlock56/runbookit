// Token-authenticated publishing, used by scripts/site.js so pages written in Claude Code
// (or any other tool) can be pushed to the live site without a browser session.
//
// Disabled unless PUBLISH_TOKEN is set. Pages are published as PUBLISH_AS (an existing
// username; defaults to the first admin) and every revision is tagged "(AI-assisted)" so
// the history shows where it came from - and, like any edit, it can be restored away.

const crypto = require('crypto');
const express = require('express');
const { db, slugify, normalizeTags, setArticleTags, resolveCategory } = require('../db');

const router = express.Router();

function tokenOk(req) {
  const expected = process.env.PUBLISH_TOKEN;
  if (!expected || expected.length < 32) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return false;
  // Compare hashes so the comparison is constant-time regardless of input length.
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function publishAuthor() {
  const configured = (process.env.PUBLISH_AS || '').trim();
  if (configured) {
    const u = db.prepare('SELECT username FROM users WHERE username_lower = ? AND banned = 0').get(configured.toLowerCase());
    return u ? u.username : null;
  }
  const admin = db.prepare('SELECT username FROM users WHERE is_admin = 1 AND banned = 0 ORDER BY created_at ASC LIMIT 1').get();
  return admin ? admin.username : null;
}

// The site's markdown renderer drops link/image URLs straight into href/src, so only
// allow http(s) links and strip embedded images from anything published this way.
function sanitizeBody(body) {
  const target = '((?:[^()]|\\([^()]*\\))+)';
  return body
    .replace(new RegExp(`!\\[([^\\]]*)\\]\\(${target}\\)`, 'g'), '$1')
    .replace(new RegExp(`\\[([^\\]]+)\\]\\(${target}\\)`, 'g'), (m, text, url) =>
      /^https?:\/\//i.test(url.trim()) ? `[${text}](${url.trim()})` : text);
}

// POST /api/publish
// Body: { title, body, category?, newCategoryLabel?, tags?, slug?, mode? }
//   slug  - update that existing article instead of creating a new one
//   mode  - 'publish' (default) or 'review' (goes to the admin review queue instead)
router.post('/publish', (req, res) => {
  if (!process.env.PUBLISH_TOKEN) return res.status(404).json({ error: 'Not found.' });
  if (!tokenOk(req)) return res.status(401).json({ error: 'Invalid publish token.' });

  const author = publishAuthor();
  if (!author) return res.status(500).json({ error: 'PUBLISH_AS does not match an active user (or there is no admin account).' });

  const { title, category, newCategoryLabel, tags, slug: targetSlug } = req.body || {};
  const mode = (req.body || {}).mode === 'review' ? 'review' : 'publish';
  if (typeof title !== 'string' || !title.trim() || typeof req.body.body !== 'string' || !req.body.body.trim()) {
    return res.status(400).json({ error: 'title and body are required.' });
  }
  if (title.length > 200) return res.status(400).json({ error: 'Title is too long (200 max).' });
  const body = sanitizeBody(req.body.body);
  if (body.length > 50000) return res.status(400).json({ error: 'Body is too long (50,000 characters max).' });
  const resolvedCategory = resolveCategory(category || null, newCategoryLabel);
  if (!resolvedCategory) return res.status(400).json({ error: `Unknown category "${category}". Use an existing slug or pass newCategoryLabel.` });
  const tagList = normalizeTags(Array.isArray(tags) ? tags : String(tags || '').split(','));
  const editor = `${author} (AI-assisted)`;
  const now = Date.now();

  const existing = targetSlug ? db.prepare('SELECT * FROM articles WHERE slug = ?').get(targetSlug) : null;
  if (targetSlug && !existing) return res.status(404).json({ error: `No article with slug "${targetSlug}".` });

  if (mode === 'review') {
    const info = db.prepare(`INSERT INTO pending_submissions (type, article_slug, title, category, body, author, created_at, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(existing ? 'edit' : 'new_article', existing ? existing.slug : null,
      title.trim(), resolvedCategory, body, author, now, JSON.stringify(tagList));
    return res.status(202).json({ pending: true, pendingId: info.lastInsertRowid });
  }

  if (existing) {
    db.transaction(() => {
      db.prepare('UPDATE articles SET title=?, category=?, body=?, updated_by=?, updated_at=? WHERE id=?')
        .run(title.trim(), resolvedCategory, body, author, now, existing.id);
      db.prepare('INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)')
        .run(existing.id, body, editor, now);
      setArticleTags(existing.id, tagList);
    })();
    return res.json({ ok: true, updated: true, slug: existing.slug });
  }

  let slug = slugify(title);
  const exists = db.prepare('SELECT 1 FROM articles WHERE slug = ?');
  let n = 2;
  while (exists.get(slug)) { slug = `${slugify(title)}-${n}`; n++; }
  db.transaction(() => {
    const info = db.prepare(`INSERT INTO articles (slug, title, category, body, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, title.trim(), resolvedCategory, body, author, now, author, now);
    db.prepare('INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)')
      .run(info.lastInsertRowid, body, editor, now);
    setArticleTags(info.lastInsertRowid, tagList);
  })();
  res.status(201).json({ ok: true, created: true, slug });
});

module.exports = router;
