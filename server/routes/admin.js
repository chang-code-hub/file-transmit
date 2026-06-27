const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/auth');
const { runCleanup } = require('../services/cleanup');
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
    'port',
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

  const oldPort = getConfig('port');
  const newConfig = updateConfig(updates);
  const response = { ...newConfig };
  delete response.adminPassword;

  const portChanged = updates.port !== undefined && updates.port !== oldPort;

  res.json({ success: true, settings: response, portChanged });

  // Hot restart if port changed (after response flushed)
  if (portChanged) {
    res.on('finish', () => {
      console.log(`端口变更: ${oldPort} → ${updates.port}`);
      req.app.locals.restartServer(updates.port).catch(err => {
        console.error('端口切换失败:', err.message);
      });
    });
  }
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

// Trigger manual cleanup
router.post('/cleanup', adminAuth, (req, res) => {
  try {
    runCleanup();
    res.json({ success: true, message: '清理任务已执行' });
  } catch (err) {
    res.status(500).json({ error: '清理任务执行失败: ' + err.message });
  }
});

module.exports = router;
