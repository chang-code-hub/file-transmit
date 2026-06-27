const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/auth');
const { getConfig, updateConfig } = require('../config');
const { getStats } = require('../db');

// Login - verify admin password
router.post('/login', (req, res) => {
  const { password } = req.body;
  const configPassword = getConfig('adminPassword');

  if (!password || password !== configPassword) {
    return res.status(401).json({ error: '管理员密码错误' });
  }

  res.json({ success: true, message: '登录成功' });
});

// Get all settings (requires auth)
router.get('/settings', adminAuth, (req, res) => {
  // Don't expose the actual password in response
  const settings = { ...getConfig() };
  delete settings.adminPassword;
  res.json(settings);
});

// Update settings (requires auth)
router.put('/settings', adminAuth, (req, res) => {
  const allowedKeys = [
    'storagePath',
    'retentionHours',
    'allowedFileTypes',
    'blockEncryptedArchives',
    'detectArchiveByContent',
    'recursiveArchiveCheck',
    'sevenZipPath',
    'enableAntivirusScan',
    'ipFilter',
  ];

  const updates = {};
  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  // Handle password change separately
  if (req.body.adminPassword && req.body.adminPassword.trim() !== '') {
    updates.adminPassword = req.body.adminPassword.trim();
  }

  const newConfig = updateConfig(updates);
  const response = { ...newConfig };
  delete response.adminPassword;

  res.json({ success: true, settings: response });
});

// Get stats (requires auth)
router.get('/stats', adminAuth, (req, res) => {
  const stats = getStats();
  const config = getConfig();
  res.json({
    ...stats,
    storagePath: config.storagePath,
    retentionHours: config.retentionHours,
  });
});

module.exports = router;
