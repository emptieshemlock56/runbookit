const express = require('express');
const crypto = require('crypto');
const { db, ensureAdminExists } = require('../db');
const {
  hashPassword, verifyPassword, signToken, signTempTotpToken, verifyTempTotpToken,
  setSessionCookie, clearSessionCookie, requireAuth,
} = require('../auth');
const { verifyTurnstile } = require('../captcha');
const { sendEmail } = require('../email');
const totp = require('../totp');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row) {
  return {
    id: row.id, username: row.username, isAdmin: !!row.is_admin, isTrusted: !!row.is_admin || !!row.trusted,
    email: row.email || null, emailVerified: !!row.email_verified, totpEnabled: !!row.totp_enabled,
  };
}
function genCode() {
  return String(crypto.randomInt(100000, 999999));
}
async function sendVerificationEmail(username, email, code) {
  await sendEmail(email, 'Verify your runbookIT.wiki email',
    `Hi ${username},\n\nYour verification code is: ${code}\n\nThis code expires in 15 minutes. If you didn't request this, you can ignore this email.`);
}

router.post('/signup', async (req, res) => {
  const { username, password, email, captchaToken } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-24 characters: letters, numbers, - or _ only.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (email !== undefined && email !== '' && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'That email address doesn\'t look valid.' });
  }

  const captcha = await verifyTurnstile(captchaToken, req.ip);
  if (!captcha.ok) return res.status(400).json({ error: captcha.error || 'CAPTCHA verification failed.' });

  const usernameLower = username.toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE username_lower = ?').get(usernameLower);
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = await hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users (username, username_lower, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, usernameLower, hash, Date.now());

  // First-ever account becomes admin automatically.
  ensureAdminExists();

  if (email) {
    const code = genCode();
    db.prepare('UPDATE users SET pending_email = ?, pending_email_code = ?, pending_email_code_expires = ? WHERE id = ?')
      .run(email, code, Date.now() + 15 * 60 * 1000, info.lastInsertRowid);
    try { await sendVerificationEmail(username, email, code); } catch (e) { console.error('Could not send verification email:', e.message); }
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
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

  if (row.totp_enabled) {
    return res.json({ requiresTotp: true, tempToken: signTempTotpToken(row.id) });
  }
  setSessionCookie(res, signToken(row));
  res.json({ user: publicUser(row) });
});

// POST /auth/login/totp - completes login after a password check that required a 2FA code.
router.post('/login/totp', (req, res) => {
  const { tempToken, code } = req.body || {};
  const uid = verifyTempTotpToken(tempToken);
  if (!uid) return res.status(401).json({ error: 'That login attempt expired. Please sign in again.' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!row || row.banned) return res.status(401).json({ error: 'Sign in required.' });
  if (!totp.verifyToken(code, row.totp_secret)) return res.status(401).json({ error: 'Incorrect code.' });

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

// --- Email verification ---

router.post('/verify-email', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row.pending_email || !row.pending_email_code) return res.status(400).json({ error: 'No email verification pending.' });
  if (Date.now() > row.pending_email_code_expires) return res.status(400).json({ error: 'That code expired - request a new one.' });
  if (String(code).trim() !== row.pending_email_code) return res.status(400).json({ error: 'Incorrect code.' });

  db.prepare('UPDATE users SET email = ?, email_verified = 1, pending_email = NULL, pending_email_code = NULL, pending_email_code_expires = NULL WHERE id = ?')
    .run(row.pending_email, row.id);
  res.json({ ok: true });
});

router.post('/resend-verification', requireAuth, async (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row.pending_email) return res.status(400).json({ error: 'No email address on file to verify.' });
  const code = genCode();
  db.prepare('UPDATE users SET pending_email_code = ?, pending_email_code_expires = ? WHERE id = ?')
    .run(code, Date.now() + 15 * 60 * 1000, row.id);
  try {
    await sendVerificationEmail(row.username, row.pending_email, code);
  } catch (e) {
    return res.status(500).json({ error: 'Could not send the email right now. Please try again shortly.' });
  }
  res.json({ ok: true });
});

// Add or change the email on file (starts a new pending verification).
router.post('/set-email', requireAuth, async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email address doesn\'t look valid.' });
  const code = genCode();
  db.prepare('UPDATE users SET pending_email = ?, pending_email_code = ?, pending_email_code_expires = ? WHERE id = ?')
    .run(email, code, Date.now() + 15 * 60 * 1000, req.user.id);
  try {
    await sendVerificationEmail(req.user.username, email, code);
  } catch (e) {
    return res.status(500).json({ error: 'Could not send the email right now. Please try again shortly.' });
  }
  res.json({ ok: true });
});

// --- Two-factor authentication (TOTP) ---

router.post('/2fa/setup', requireAuth, async (req, res) => {
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?').run(secret, req.user.id);
  const qrDataUrl = await totp.generateQrDataUrl(req.user.username, secret);
  res.json({ secret, qrDataUrl });
});

router.post('/2fa/confirm', requireAuth, (req, res) => {
  const { code } = req.body || {};
  const row = db.prepare('SELECT totp_pending_secret FROM users WHERE id = ?').get(req.user.id);
  if (!row.totp_pending_secret) return res.status(400).json({ error: 'Start 2FA setup first.' });
  if (!totp.verifyToken(code, row.totp_pending_secret)) return res.status(400).json({ error: 'Incorrect code - check your authenticator app and try again.' });

  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_pending_secret = NULL WHERE id = ?')
    .run(row.totp_pending_secret, req.user.id);
  res.json({ ok: true });
});

router.post('/2fa/disable', requireAuth, (req, res) => {
  const { code } = req.body || {};
  const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!row.totp_enabled) return res.status(400).json({ error: '2FA is not enabled.' });
  if (!totp.verifyToken(code, row.totp_secret)) return res.status(400).json({ error: 'Incorrect code.' });

  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_pending_secret = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
