const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/auth');
const logger = require('../utils/logger');
const { runCleanup } = require('../services/cleanup');
const { getConfig, updateConfig } = require('../config');
const { getStats } = require('../db');

// Login - verify admin password
router.post('/login', (req, res) => {
  const { password } = req.body;
  const configPassword = getConfig('adminPassword');
  const clientIp = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');

  if (!password || password !== configPassword) {
    logger.log(`[管理] 登录失败: 密码错误, IP=${clientIp}`);
    return res.status(401).json({ error: '管理员密码错误' });
  }

  logger.log(`[管理] 登录成功, IP=${clientIp}`);
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
    'enableVirusDetect',
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
  const changedKeys = Object.keys(updates).filter(k => k !== 'adminPassword');
  const newConfig = updateConfig(updates);
  const response = { ...newConfig };
  delete response.adminPassword;

  const portChanged = updates.port !== undefined && updates.port !== oldPort;

  if (changedKeys.length > 0) {
    logger.log(`[管理] 设置已更新: ${changedKeys.join(', ')}`);
  }
  if (updates.adminPassword) {
    logger.log('[管理] 管理员密码已更改');
  }

  res.json({ success: true, settings: response, portChanged });

  // Hot restart if port changed (after response flushed)
  if (portChanged) {
    res.on('finish', () => {
      logger.log(`[管理] 端口变更: ${oldPort} → ${updates.port}`);
      req.app.locals.restartServer(updates.port).catch(err => {
        logger.error('[管理] 端口切换失败:', err.message);
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
    logger.log('[管理] 手动触发清理任务');
    runCleanup();
    res.json({ success: true, message: '清理任务已执行' });
  } catch (err) {
    logger.error('[管理] 清理任务执行失败:', err.message);
    res.status(500).json({ error: '清理任务执行失败: ' + err.message });
  }
});

module.exports = router;
