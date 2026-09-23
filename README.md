# runbookIT.wiki

A community-editable IT SOP wiki, crossed with a comment section - Wikipedia x Reddit for sysadmins. Anyone can browse and read; a free account is required to create/edit articles or leave comments. Every edit is kept in a revision history that anyone can view or restore.

Node.js + Express backend, SQLite database, cookie-based sessions with bcrypt-hashed passwords.

Note: internal identifiers (the npm package name, the SQLite filename `howtosysadmin.db`) were left as-is during the rebrand - they're invisible to visitors and renaming the database file would mean migrating your live data for no visible benefit. Only user-facing text and the visual design changed.

## What's included

- `server.js` - Express app entry point, rate limiting on auth/write endpoints
- `db.js` - SQLite schema, migrations, admin bootstrap, seed data
- `auth.js` - password hashing (bcrypt), session cookies (JWT), admin/ban-aware middleware
- `routes/auth.js` - signup / login / logout / current-user
- `routes/articles.js` - articles, revisions, threaded comments, article locking
- `routes/admin.js` - ban / unban accounts (admin only)
- `public/` - the frontend (plain HTML/CSS/JS, no build step)

## Running it locally

```bash
cd howtosysadmin-app
npm install
cp .env.example .env
```

Open `.env` and set `JWT_SECRET` to a real random string:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
For local development, also set `NODE_ENV=development` in `.env` (production mode requires HTTPS for login to work, which localhost isn't).

```bash
npm start
```

Visit **http://localhost:3000**.

## Editing features

- **Formatting toolbar**: the article editor has buttons for headings, bold, italic, inline code, bullet/numbered lists, blockquotes, links, and code blocks. They wrap or insert the right markdown around your selection - you can also just type markdown directly if you prefer.
- **Copy buttons**: every code block in a rendered article gets a "Copy" button, same as this chat interface.

## Voting, images, mentions, and diffs

- **Helpful / not helpful voting** on every article, one vote per account, switchable or removable anytime.
- **Image uploads** in the editor - PNG/JPG/GIF/WEBP only (SVG is deliberately blocked, since it can carry embedded scripts), 5MB cap, inserted as markdown at your cursor.
- **@mentions** - typing `@username` in a comment notifies that person (if the username is real). Replying to someone's comment also notifies them. A bell icon in the nav shows unread count and a dropdown of recent notifications.
- **Revision diffs** - "Diff vs current" on any past revision shows a line-by-line comparison (added lines in green, removed in red) before you decide whether to restore it.

## Search, tags, bookmarks, and profiles

- **Real full-text search** (SQLite FTS5) searches article titles *and* bodies, not just excerpts - tested against content buried deep in an article, not just the title. Automatically stays in sync as articles are created/edited via database triggers. Every search that returns zero results is logged (`search_log` table) so you can see what people are looking for that doesn't exist yet.
- **Tags** - up to 8 per article, comma-separated in the editor, normalized and deduped automatically. Click a tag chip anywhere to filter by it. Tags survive the new-account review queue and get applied on approval.
- **Bookmarks** - any signed-in user can save an article from its page; "Bookmarks" in the nav shows everything they've saved.
- **Public contributor profiles** - click any username (in an article's byline or a comment) to see their joined date, articles created, edits made, and comments posted. No sensitive fields exposed.
- **Leaderboard** - ranks contributors by articles + edits combined.
- **RSS feed** at `/rss.xml` - the 30 most recently updated articles, standard RSS 2.0, works in any feed reader.
- **Markdown export** - every article has an "Export .md" button that downloads the raw source.

## Reporting

Any signed-in user can report an article or a comment (a small "Report" button, prompts for a reason). Admins see a red "REPORTS (N)" badge in the nav the moment something's flagged - even if the admin is the one who just filed it - and a Reports page listing each one with its target and reason. Dismissing just clears the report; if the content itself needs action, use the existing lock/ban/delete tools separately.

## S3 backups

Admin page → "Backup settings" (linked from Manage Users). Set a bucket, region, and an IAM access key/secret, then either click "Back up now" or check "Run automatically once a day." Backs up all three SQLite files (`.db`, `-wal`, `-shm`) to `backups/<timestamp>/` in the bucket. The secret key is stored server-side only and is never sent back to the browser - leave the key fields blank when updating other settings to keep what's already saved.

**AWS setup needed before this works for real:**
1. Create an S3 bucket (any region).
2. Create an IAM user (or role) with a policy allowing `s3:PutObject` on that bucket - doesn't need broader S3 access.
3. Generate an access key for that IAM user, paste the key ID/secret into the admin page.

## Moderation & abuse protection

This is a genuinely open wiki - anyone with an account can edit anything - so a few protections are built in:

- **Everything is reversible.** Every edit is a new revision, never an overwrite. Any signed-in user can view an article's full history and restore an older version in one click. This is the single biggest protection: fixing vandalism takes seconds.
- **Rate limiting.** Login/signup are capped at 15 attempts per 15 minutes per IP (blocks brute-force and mass account creation). Article creation/editing and comments are capped at 60 per 15 minutes per IP (blocks scripted spam).
- **Admin role.** The very first account ever created on a fresh install is automatically promoted to admin (check `db.js` -> `ensureAdminExists`). Admins can:
  - **Lock an article** so only admins can edit it - use this on a page that's a repeated vandalism target.
  - **Delete any comment**, not just their own (still soft-deleted, so replies underneath are preserved).
  - **Ban a user account** - a banned account can no longer log in, effective immediately even if they're already signed in. Two ways to do it: click the admin badge in the nav bar for a full user management page (every account, join date, activity counts, ban/unban with one click), or use the quick "ban user" button next to a bad comment for fast action right from where you spotted it.
- **Soft-deleted comments** show as "[deleted]" but the row and any replies stay in place, so a vandal deleting their own comment can't blow away a whole conversation thread.
- **New-account review queue.** A brand-new account's first article, edit, or revision-restore is held in a review queue rather than going live immediately - it doesn't touch the real article until an admin approves it. Approving publishes it instantly and marks that account trusted, so everything after their first approved contribution goes live immediately like normal. Reject discards it with no changes applied. Admins see a red "review (N)" badge in the nav whenever something's waiting; click it to open the queue.
  - **Comments are not held** - only articles and edits. A brand-new account can comment immediately; the ban/soft-delete tools cover comment abuse.
  - **Existing accounts were grandfathered in automatically** the first time this feature's migration ran - anyone who already had a real article or edit on record before this existed was marked trusted, so this only ever holds back genuinely new signups going forward.
- **Per-user "Rejected" and "Removed" counters** on the Manage Users page give a quick read on who's causing trouble: "Rejected" counts how many of that account's submissions an admin turned down in the review queue; "Removed" counts comments an admin took down from them specifically (a user deleting their own comment doesn't count against them - that's normal use, not a moderation action).

There's currently no password-reset flow (see below) and no email verification - reasonable for a small trusted community, worth adding if this opens up publicly.

## Forgot a password?

There's no self-service reset yet. Since this is your own database, you can reset one directly:
```bash
node -e "
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db = new Database('data/howtosysadmin.db');
const hash = bcrypt.hashSync('new-password-here', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE username_lower = ?').run(hash, 'the-username');
console.log('done');
"
```

## Deploying it for real

### Option A: Railway or Render (easiest)

1. Push this folder to a GitHub repo.
2. Create a new Web Service pointing at that repo; start command `npm start`.
3. Set env var `JWT_SECRET` (generate as above) and `NODE_ENV=production`.
4. **Attach a persistent volume/disk mounted at `data/`** - without one, your SQLite database gets wiped on every redeploy.
5. Deploy, then point your own domain at the generated URL.

### Option B: A small VPS - more control

1. Provision Ubuntu, install Node.js 18+ (LTS recommended - see the native-module note below).
2. Copy this folder over, `npm install --production`, set up `.env`.
3. Run under a process manager:
   ```bash
   npm install -g pm2
   pm2 start server.js --name howtosysadmin
   pm2 save && pm2 startup
   ```
4. Put Nginx in front as a reverse proxy and get a free TLS cert with Certbot.

### A note on Node versions

`better-sqlite3` is a native module (compiled code, not pure JavaScript). Prebuilt binaries and build compatibility for it - and for native modules in general - typically lag a bit behind Node's very newest releases. Run this on the current **Node LTS** version rather than the newest non-LTS release to avoid rebuild headaches; `nvm install --lts && nvm use --lts` if you're using nvm.

### Moving to Postgres later

SQLite comfortably handles far more traffic than a small community wiki will see. If you outgrow it, only `db.js` needs rework - the route files use plain SQL, so swapping in `pg` later is a contained change, not a rewrite.

## Customizing

- Starter articles / categories: edit `SEED` and `CATEGORIES` in `db.js` (mirror the category list in `public/app.js`).
- Look and feel: CSS variables at the top of `public/styles.css`.
