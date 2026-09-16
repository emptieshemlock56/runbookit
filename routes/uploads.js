const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
// SVG is deliberately excluded - it can carry embedded <script>, a real XSS vector for user uploads.

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype] || '.bin';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) return cb(new Error('Only PNG, JPG, GIF, or WEBP images are allowed.'));
    cb(null, true);
  },
});

// POST /api/uploads - auth required. Returns a URL to embed with ![alt](url) markdown.
router.post('/uploads', requireAuth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No image provided.' });
    db.prepare('INSERT INTO uploads (filename, uploaded_by, created_at) VALUES (?, ?, ?)')
      .run(req.file.filename, req.user.username, Date.now());
    res.status(201).json({ url: '/uploads/' + req.file.filename });
  });
});

module.exports = router;
