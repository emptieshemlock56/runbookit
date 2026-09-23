const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSetting, setSetting } = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILES = ['howtosysadmin.db', 'howtosysadmin.db-wal', 'howtosysadmin.db-shm'];

function getBackupConfig() {
  return {
    bucket: getSetting('s3_bucket') || '',
    region: getSetting('s3_region') || '',
    hasCredentials: !!(getSetting('s3_access_key_id') && getSetting('s3_secret_access_key')),
    autoEnabled: getSetting('s3_auto_enabled') === '1',
    lastBackupAt: getSetting('s3_last_backup_at') ? Number(getSetting('s3_last_backup_at')) : null,
    lastBackupStatus: getSetting('s3_last_backup_status') || null,
    lastBackupError: getSetting('s3_last_backup_error') || null,
  };
}

// accessKeyId/secretAccessKey are optional here on purpose - if left blank, the
// previously saved credentials are kept rather than being wiped out, so the admin
// doesn't have to re-paste secrets every time they just want to change the bucket
// name or toggle auto-backup.
function saveBackupConfig({ bucket, region, accessKeyId, secretAccessKey, autoEnabled }) {
  if (bucket !== undefined) setSetting('s3_bucket', bucket.trim());
  if (region !== undefined) setSetting('s3_region', region.trim());
  if (accessKeyId) setSetting('s3_access_key_id', accessKeyId.trim());
  if (secretAccessKey) setSetting('s3_secret_access_key', secretAccessKey.trim());
  if (autoEnabled !== undefined) setSetting('s3_auto_enabled', autoEnabled ? '1' : '0');
}

function isConfigured() {
  return !!(getSetting('s3_bucket') && getSetting('s3_region') && getSetting('s3_access_key_id') && getSetting('s3_secret_access_key'));
}

async function runBackup() {
  if (!isConfigured()) {
    throw new Error('S3 backup is not configured yet - set a bucket, region, and credentials first.');
  }
  const bucket = getSetting('s3_bucket');
  const region = getSetting('s3_region');
  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: getSetting('s3_access_key_id'),
      secretAccessKey: getSetting('s3_secret_access_key'),
    },
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const existing = DB_FILES.filter(f => fs.existsSync(path.join(DATA_DIR, f)));
  if (!existing.length) {
    throw new Error('No database files found to back up.');
  }

  try {
    for (const filename of existing) {
      const body = fs.readFileSync(path.join(DATA_DIR, filename));
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `backups/${stamp}/${filename}`,
        Body: body,
      }));
    }
    setSetting('s3_last_backup_at', String(Date.now()));
    setSetting('s3_last_backup_status', 'ok');
    setSetting('s3_last_backup_error', null);
    return { ok: true, filesUploaded: existing.length, prefix: `backups/${stamp}/` };
  } catch (err) {
    setSetting('s3_last_backup_at', String(Date.now()));
    setSetting('s3_last_backup_status', 'error');
    setSetting('s3_last_backup_error', err.message || String(err));
    throw err;
  }
}

// Called periodically (see server.js). Runs a backup if auto-backup is enabled
// and it's been at least ~24h since the last one (or none has ever run).
async function maybeRunScheduledBackup() {
  const cfg = getBackupConfig();
  if (!cfg.autoEnabled || !isConfigured()) return;
  const dayMs = 24 * 60 * 60 * 1000;
  if (cfg.lastBackupAt && Date.now() - cfg.lastBackupAt < dayMs) return;
  try {
    await runBackup();
    console.log('Scheduled S3 backup completed.');
  } catch (err) {
    console.error('Scheduled S3 backup failed:', err.message);
  }
}

module.exports = { getBackupConfig, saveBackupConfig, isConfigured, runBackup, maybeRunScheduledBackup };
