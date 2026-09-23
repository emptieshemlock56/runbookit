const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'howtosysadmin.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  username_lower TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  editor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, -- 'new_article' | 'edit'
  article_slug TEXT, -- set for 'edit': the existing article being changed
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revisions_article ON revisions(article_id);
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id);
`);

// --- Migrations ---
// Safe to run every startup: only adds a column if it isn't already there, so this
// never touches or wipes existing data on a database that's already running.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`Migrated: added ${table}.${column}`);
  }
}
ensureColumn('comments', 'parent_id', 'parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE');
ensureColumn('comments', 'deleted_at', 'deleted_at INTEGER');
ensureColumn('users', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'banned', 'banned INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'trusted', 'trusted INTEGER NOT NULL DEFAULT 0');
ensureColumn('articles', 'locked', 'locked INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'rejected_count', 'rejected_count INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'comments_removed_count', 'comments_removed_count INTEGER NOT NULL DEFAULT 0');
ensureColumn('pending_submissions', 'tags', "tags TEXT NOT NULL DEFAULT '[]'");
ensureColumn('users', 'email', 'email TEXT');
ensureColumn('users', 'email_verified', 'email_verified INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'pending_email', 'pending_email TEXT');
ensureColumn('users', 'pending_email_code', 'pending_email_code TEXT');
ensureColumn('users', 'pending_email_code_expires', 'pending_email_code_expires INTEGER');
ensureColumn('users', 'totp_secret', 'totp_secret TEXT');
ensureColumn('users', 'totp_pending_secret', 'totp_pending_secret TEXT');
ensureColumn('users', 'totp_enabled', 'totp_enabled INTEGER NOT NULL DEFAULT 0');

// --- New tables (additive - never touches existing data) ---
db.exec(`
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS article_tags (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL, -- 'article' | 'comment'
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reporter TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'dismissed'
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookmarks (
  username TEXT NOT NULL,
  article_slug TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (username, article_slug)
);
CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  results_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS article_votes (
  username TEXT NOT NULL,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  vote INTEGER NOT NULL, -- 1 (helpful) or -1 (not helpful)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (username, article_id)
);
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL, -- recipient
  type TEXT NOT NULL, -- 'mention' | 'reply'
  message TEXT NOT NULL,
  link TEXT NOT NULL, -- article slug to open
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_username ON notifications(username);
CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, body, content='articles', content_rowid='id'
);
`);

// Keep the FTS index in sync with the real articles table automatically.
db.exec(`
CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
  INSERT INTO articles_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
`);

// One-time backfill: populate the FTS index for any articles that existed before
// this feature (the triggers above only fire on future inserts/updates).
function backfillFts() {
  const ftsCount = db.prepare('SELECT COUNT(*) AS c FROM articles_fts').get().c;
  const articleCount = db.prepare('SELECT COUNT(*) AS c FROM articles').get().c;
  if (ftsCount >= articleCount) return;
  db.exec(`INSERT INTO articles_fts(rowid, title, body) SELECT id, title, body FROM articles
    WHERE id NOT IN (SELECT rowid FROM articles_fts);`);
}
backfillFts();

const DEFAULT_CATEGORIES = [
  ['networking', 'Networking & Firewalls'],
  ['windows_ad', 'Windows & Active Directory'],
  ['linux', 'Linux'],
  ['cloud_aws', 'Cloud & AWS'],
  ['security', 'Security & Compliance'],
  ['automation', 'Scripting & Automation'],
  ['monitoring', 'Monitoring & Alerting'],
  ['misc', 'Miscellaneous'],
];
function seedCategoriesIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO categories (slug, label, created_at) VALUES (?, ?, ?)');
  const now = Date.now();
  for (const [slug, label] of DEFAULT_CATEGORIES) insert.run(slug, label, now);
}
seedCategoriesIfEmpty();

function categorySlugify(label) {
  return String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'category';
}
// Finds a category by slug, or creates one from a human-entered label if it doesn't exist yet.
// Returns the resolved slug, or null if neither a valid slug nor a usable label was given.
function resolveCategory(slugOrNull, newLabel) {
  if (slugOrNull) {
    const existing = db.prepare('SELECT slug FROM categories WHERE slug = ?').get(slugOrNull);
    if (existing) return existing.slug;
  }
  const label = String(newLabel || '').trim().slice(0, 60);
  if (!label) return null;
  // If a category with this exact label (case-insensitive) already exists, reuse it
  // instead of creating a near-duplicate under a different slug.
  const byLabel = db.prepare('SELECT slug FROM categories WHERE LOWER(label) = LOWER(?)').get(label);
  if (byLabel) return byLabel.slug;
  let slug = categorySlugify(label);
  const existsStmt = db.prepare('SELECT 1 FROM categories WHERE slug = ?');
  let n = 2;
  while (existsStmt.get(slug)) { slug = categorySlugify(label) + '_' + n; n++; }
  db.prepare('INSERT INTO categories (slug, label, created_at) VALUES (?, ?, ?)').run(slug, label, Date.now());
  return slug;
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);`);

// Grandfather in anyone who already has a real contribution on record, so this
// feature only ever holds back genuinely brand-new accounts going forward.
// Safe to run every startup - only touches rows that aren't already trusted.
function backfillTrustedContributors() {
  const authors = db.prepare('SELECT DISTINCT created_by AS u FROM articles').all().map(r => r.u);
  const editors = db.prepare('SELECT DISTINCT editor AS u FROM revisions').all()
    .map(r => r.u.replace(/ \(restored\)$/, ''));
  const usernames = [...new Set([...authors, ...editors])];
  if (!usernames.length) return;
  const placeholders = usernames.map(() => '?').join(',');
  db.prepare(`UPDATE users SET trusted = 1 WHERE trusted = 0 AND username IN (${placeholders})`).run(...usernames);
}
backfillTrustedContributors();

// Bootstrap: if no admin exists yet, promote whoever has the oldest account.
// Runs on every startup but is a no-op once an admin exists, so it's always safe.
function ensureAdminExists() {
  const hasAdmin = db.prepare('SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (hasAdmin) return;
  const oldest = db.prepare('SELECT id, username FROM users ORDER BY created_at ASC LIMIT 1').get();
  if (oldest) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(oldest.id);
    console.log(`No admin found - promoted "${oldest.username}" (oldest account) to admin.`);
  }
}
ensureAdminExists();

function slugify(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'article';
}

function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(t => String(t).toLowerCase().trim().replace(/[^a-z0-9\- ]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 8);
}
function setArticleTags(articleId, tagNames) {
  db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId);
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insertTag = db.prepare('INSERT INTO tags (name) VALUES (?)');
  const link = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  for (const name of tagNames) {
    let tag = findTag.get(name);
    if (!tag) tag = { id: insertTag.run(name).lastInsertRowid };
    link.run(articleId, tag.id);
  }
}
function getArticleTags(articleId) {
  return db.prepare(`SELECT t.name FROM tags t
    JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ?`).all(articleId).map(r => r.name);
}
function excerptOf(body) {
  return body.replace(/[#>*`\-]/g, '').trim().slice(0, 140) + (body.length > 140 ? '...' : '');
}
function toIndexRow(a) {
  const revisionCount = db.prepare('SELECT COUNT(*) AS c FROM revisions WHERE article_id = ?').get(a.id).c;
  const commentCount = db.prepare('SELECT COUNT(*) AS c FROM comments WHERE article_id = ? AND deleted_at IS NULL').get(a.id).c;
  return {
    slug: a.slug, title: a.title, category: a.category,
    excerpt: excerptOf(a.body),
    updatedAt: a.updated_at, updatedBy: a.updated_by,
    revisionCount, commentCount, locked: !!a.locked,
    tags: getArticleTags(a.id),
  };
}

const SEED = [
  {
    title: 'FortiGate Baseline Configuration Checklist',
    category: 'networking',
    body: `# Purpose

A baseline checklist for standing up a new FortiGate firewall before it goes into production.

## Initial hardening

- Change default admin password and rename the default admin account
- Disable HTTP admin access, HTTPS only, restrict to a management VLAN
- Set up NTP so logs and certificates are trustworthy
- Enable and configure central logging (FortiAnalyzer or syslog)

## Interface & zone setup

- Separate WAN, LAN, DMZ, and management into distinct zones
- Tag VLANs consistently with the switch-side config
- Document subnet ranges in the change ticket, not just the firewall

## Policy hygiene

- Default deny at the bottom of every policy table
- No "any/any" rules outside of temporary troubleshooting (and log + expire them)
- Use address and service objects instead of raw IPs so audits are readable

\`\`\`
config firewall policy
  edit 1
    set srcintf "lan"
    set dstintf "wan"
    set srcaddr "all"
    set dstaddr "all"
    set action deny
  next
end
\`\`\`

## Before go-live

- Full config backup exported off-box
- HA sync verified if running a cluster
- Change window documented and rollback plan written`,
  },
  {
    title: 'AWS Transit Gateway Multi-Account Design Patterns',
    category: 'cloud_aws',
    body: `# When to reach for Transit Gateway

If you have more than a handful of VPCs across multiple AWS accounts that need to talk to each other (and to on-prem), VPC peering mesh stops scaling. Transit Gateway (TGW) centralizes routing.

## Core pattern

- One TGW per region, owned by a central network/shared-services account
- Share the TGW to spoke accounts via AWS RAM (Resource Access Manager)
- Each spoke VPC attaches to the TGW; spoke accounts don't manage the TGW itself

## Route table segmentation

- Don't dump every attachment into the default TGW route table
- Create separate route tables per trust boundary (e.g., prod, non-prod, shared-services, on-prem)
- Associate attachments to the route table matching their trust boundary, and only propagate the routes each boundary should actually see

## On-prem connectivity

- Terminate Direct Connect or Site-to-Site VPN on the TGW directly rather than in a single VPC
- This avoids designing around a "transit VPC" hop and its instance-based bottleneck

## Common mistakes

- Forgetting that TGW attachments are billed per attachment-hour plus data processed - sprawling accounts add up
- Skipping route table segmentation, which quietly turns TGW into "everything can reach everything"
- Not tagging attachments with owning account/team, making cleanup painful later`,
  },
  {
    title: 'New Sysadmin 90-Day Onboarding Runbook',
    category: 'misc',
    body: `# Goal

A repeatable checklist for bringing a new systems administrator up to speed, especially useful when you're the one building IT from the ground up.

## Days 1-30: Inventory & access

- Get accounts provisioned: AD/Okta, M365, RMM console, firewall/network management, cloud consoles
- Build (or find) the network diagram - if it doesn't exist, start drafting one from DHCP leases and switch configs
- Inventory every server, switch, firewall, and SaaS subscription into a single source of truth
- Identify anything end-of-life or unsupported

## Days 31-60: Stabilize

- Confirm backups are actually running and a restore has been tested recently
- Patch management: confirm a cadence exists (or set one up in your RMM)
- Document the top 10 recurring tickets and write runbooks for them
- Review firewall rules and admin access for anything that shouldn't still be there

## Days 61-90: Improve

- Stand up monitoring/alerting for anything business-critical that isn't watched yet
- Start a documentation habit: every non-trivial fix gets a short write-up
- Identify the single biggest single point of failure and propose a fix
- Set a recurring cadence for reviewing access, licenses, and unused assets`,
  },
  {
    title: 'Active Directory Health Check Script (PowerShell)',
    category: 'windows_ad',
    body: `# What this checks

A quick PowerShell pass to catch common AD problems before they become incidents.

\`\`\`
# Replication health
repadmin /replsummary

# DCs and their roles
Get-ADDomainController -Filter * | Select Name, OperationMasterRoles

# Stale computer accounts (90+ days inactive)
$cutoff = (Get-Date).AddDays(-90)
Get-ADComputer -Filter {LastLogonTimestamp -lt $cutoff} -Properties LastLogonTimestamp

# Users with password never expires
Get-ADUser -Filter {PasswordNeverExpires -eq $true} -Properties PasswordNeverExpires
\`\`\`

## What to do with the output

- Replication errors: resolve before anything else, they cascade into weirder problems
- Stale computer accounts: disable, then delete after a grace period, don't delete blind
- Password-never-expires accounts: these should be an intentional, documented, short list - audit anything unexpected

## Suggested cadence

Run monthly at minimum; wire into a scheduled task or your RMM if you want it automatic and want history over time.`,
  },
  {
    title: 'Zscaler Rollout: Lessons From a Production Migration',
    category: 'security',
    body: `# Context

Notes from migrating a distributed workforce onto Zscaler Internet Access from a traditional hub-and-spoke VPN model.

## Before you touch a single endpoint

- Inventory every SaaS app and internal app your users actually touch - you will find surprises
- Decide your SSL inspection policy up front; retrofitting it after rollout causes a wave of "why is this site broken" tickets
- Bypass list: banking, some conferencing tools, and anything with certificate pinning generally needs explicit exceptions

## Rollout approach that worked

- Pilot with IT first, then one small friendly department, before company-wide
- Push the client via RMM/MDM rather than asking users to self-install
- Keep the legacy VPN alive in parallel for two full weeks as a rollback path

## Common breakage after cutover

- Certificate-pinned apps failing SSL inspection - add to bypass list rather than fighting it
- Split-tunnel apps that assume they're on a flat internal network
- Printers and other non-user devices that don't support the client - route through a location-based tunnel instead

## Post-rollout

- Review logs weekly for the first month; policy tuning is where most of the real work happens
- Decommission the legacy VPN only after a full billing cycle with zero fallback usage`,
  },
];

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM articles').get().c;
  if (count > 0) return;
  const now = Date.now();
  const insertArticle = db.prepare(`INSERT INTO articles (slug, title, category, body, created_by, created_at, updated_by, updated_at)
    VALUES (@slug, @title, @category, @body, @createdBy, @createdAt, @updatedBy, @updatedAt)`);
  const insertRevision = db.prepare(`INSERT INTO revisions (article_id, body, editor, created_at) VALUES (?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const s of SEED) {
      const slug = slugify(s.title);
      const info = insertArticle.run({
        slug, title: s.title, category: s.category, body: s.body,
        createdBy: 'founder', createdAt: now, updatedBy: 'founder', updatedAt: now,
      });
      insertRevision.run(info.lastInsertRowid, s.body, 'founder', now);
    }
  });
  tx();
  console.log(`Seeded ${SEED.length} starter articles.`);
}

seedIfEmpty();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));
}

module.exports = { db, slugify, ensureAdminExists, normalizeTags, setArticleTags, getArticleTags, toIndexRow, resolveCategory, categorySlugify, getSetting, setSetting };
