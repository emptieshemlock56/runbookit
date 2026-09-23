require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { attachUser } = require('./auth');
const { db } = require('./db');
const { maybeRunScheduledBackup } = require('./backup');
const authRoutes = require('./routes/auth');
const articleRoutes = require('./routes/articles');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const uploadRoutes = require('./routes/uploads');
const notificationRoutes = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust one hop of proxy (needed for correct client IPs behind Railway/Render/Nginx)
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Only needed if you serve the frontend from a different origin than the API
// (e.g. a separate static host). If frontend and API are on the same domain,
// CORS_ORIGIN can be left unset.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

app.use(attachUser);

// Rate limiting: throttles brute-force login attempts, signup spam, and scripted
// mass-editing/commenting. These are generous enough for normal human use.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many changes in a short time. Please slow down and try again shortly.' },
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/articles', (req, res, next) => {
  if (req.method === 'GET') return next();
  return writeLimiter(req, res, next);
});
app.use('/api/uploads', writeLimiter);

app.use('/api/auth', authRoutes);
app.use('/api', articleRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);
app.use('/api', uploadRoutes);
app.use('/api', notificationRoutes);

// RSS feed of the most recently updated articles - plain XML, no auth, standard RSS reader path.
app.get('/rss.xml', (req, res) => {
  const rows = db.prepare('SELECT * FROM articles ORDER BY updated_at DESC LIMIT 30').all();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const host = req.protocol + '://' + req.get('host');
  const items = rows.map(a => `
    <item>
      <title>${esc(a.title)}</title>
      <link>${host}/#article/${esc(a.slug)}</link>
      <guid isPermaLink="false">${esc(a.slug)}</guid>
      <pubDate>${new Date(a.updated_at).toUTCString()}</pubDate>
      <description>${esc(a.body.replace(/[#>*`]/g, '').trim().slice(0, 300))}</description>
    </item>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>runbookIT.wiki</title>
  <link>${host}</link>
  <description>Community-written IT how-tos, most recently updated first.</description>
  ${items}
</channel></rss>`;
  res.type('application/rss+xml').send(xml);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`howtosysadmin running at http://localhost:${PORT}`);
});

// Auto-backup check: runs on startup, then every hour. Each run is a no-op unless
// auto-backup is enabled, configured, and it's been ~24h since the last successful run.
maybeRunScheduledBackup();
setInterval(maybeRunScheduledBackup, 60 * 60 * 1000);
