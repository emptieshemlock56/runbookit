const express = require('express');
const { requireAdmin } = require('../auth');
const writer = require('../agent/writer');

const router = express.Router();

// GET /api/admin/agent/jobs - recent AI writer jobs + whether an API key is configured
router.get('/agent/jobs', requireAdmin, (req, res) => {
  res.json({ configured: writer.isConfigured(), model: writer.MODEL, jobs: writer.listJobs() });
});

// GET /api/admin/agent/jobs/:id - one job, for polling progress
router.get('/agent/jobs/:id', requireAdmin, (req, res) => {
  const job = writer.getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({ job });
});

// POST /api/admin/agent/jobs - start a new page. body: { prompt, mode: 'publish' | 'review' }
router.post('/agent/jobs', requireAdmin, (req, res) => {
  if (!writer.isConfigured()) {
    return res.status(503).json({ error: 'Set ANTHROPIC_API_KEY in .env and restart the server to use the AI writer.' });
  }
  const prompt = String((req.body || {}).prompt || '').trim();
  const mode = (req.body || {}).mode === 'review' ? 'review' : 'publish';
  if (prompt.length < 10) return res.status(400).json({ error: 'Describe the page you want in a bit more detail.' });
  if (prompt.length > 4000) return res.status(400).json({ error: 'Request is too long (4000 characters max).' });
  const id = writer.createJob({ prompt, mode, requestedBy: req.user.username });
  res.status(202).json({ id });
});

module.exports = router;
