const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Set it in your .env file (see .env.example).');
  process.exit(1);
}
const COOKIE_NAME = 'howto_session';
const TOKEN_TTL = '30d';

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
// Minimum 10 characters, at least one uppercase, one lowercase, one number.
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Z]/.test(pw)) return 'Password must include at least one uppercase letter.';
  if (!/[a-z]/.test(pw)) return 'Password must include at least one lowercase letter.';
  if (!/[0-9]/.test(pw)) return 'Password must include at least one number.';
  return null;
}
async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}
function signToken(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}
// Short-lived, purpose-scoped token used to carry a user through a login "challenge"
// step (2FA code, email verification code) - never set as a cookie, never grants a
// real session on its own. A token signed for one purpose can't be reused for another.
function signTempToken(userId, purpose, ttl) {
  return jwt.sign({ uid: userId, purpose }, JWT_SECRET, { expiresIn: ttl || '15m' });
}
function verifyTempToken(token, purpose) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.purpose === purpose ? decoded.uid : null;
  } catch (e) {
    return null;
  }
}
function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}
function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}
function readUidFromCookie(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET).uid;
  } catch (e) {
    return null;
  }
}
// Looks up the user fresh from the DB on every request (not just trusting the JWT payload),
// so a ban or admin-status change takes effect immediately instead of waiting for the
// 30-day token to expire. Never blocks the request - just attaches req.user or leaves it null.
function attachUser(req, res, next) {
  const uid = readUidFromCookie(req);
  if (!uid) { req.user = null; return next(); }
  const row = db.prepare('SELECT id, username, is_admin, banned, trusted, email, email_verified, totp_enabled FROM users WHERE id = ?').get(uid);
  if (!row || row.banned) { req.user = null; return next(); }
  req.user = {
    id: row.id, username: row.username, isAdmin: !!row.is_admin, isTrusted: !!row.is_admin || !!row.trusted,
    email: row.email || null, emailVerified: !!row.email_verified, totpEnabled: !!row.totp_enabled,
  };
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

module.exports = {
  hashPassword, verifyPassword, validatePassword, signToken, signTempToken, verifyTempToken,
  setSessionCookie, clearSessionCookie,
  attachUser, requireAuth, requireAdmin, COOKIE_NAME,
};
