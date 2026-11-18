const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/auth');
const logger = require('../utils/logger');
const { runCleanup } = require('../services/cleanup');
const { getConfig, updateConfig, normalizeProxyBaseUrl, isIpFilterActive, validateWebhook } = require('../config');
const { checkToolStatus } = require('../services/archiveCheck');
const { getStats } = require('../db');

// Login - verify admin password
router.post('/login', (req, res) => {
  const { password } = req.body;
  const configPassword = getConfig('adminPassword');
  const clientIp = require('../utils/clientIp').clientIpOf(req);

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
  // 只回传「是否是自动生成的」布尔值，口令本身永不下发
  settings.adminPasswordIsGenerated = !!getConfig('adminPasswordIsGenerated');
  settings.ipFilterEnabled = isIpFilterActive();
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
    'unrarPath',
    'enableVirusDetect',
    'clamscanPath',
    'ipFilter',
    'trustProxy',
    'preferLocalDownload',
    'uploadProxy',
    'downloadProxy',
    'webhooks',
    'webhookPublicUrl',
    'webhookTimeoutMs',
    'downloadToken',
  ];

  const updates = {};

  // 代理转发（两路独立）与 webhook 列表：需逐项校验后再落盘
  const PROXY_KEYS = ['uploadProxy', 'downloadProxy'];
  const OBJECT_KEYS = [...PROXY_KEYS, 'webhooks', 'webhookPublicUrl', 'webhookTimeoutMs', 'downloadToken'];

  for (const key of allowedKeys) {
    if (OBJECT_KEYS.includes(key)) continue;
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  // webhook 列表：可配多个，逐个校验；启用的那条地址必须是合法 http(s) URL
  if (req.body.webhooks !== undefined) {
    const raw = req.body.webhooks;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'Webhooks 必须是数组' });
    }
    if (raw.length > 20) {
      return res.status(400).json({ error: '最多只能配置 20 个 Webhook' });
    }
    const list = [];
    for (let idx = 0; idx < raw.length; idx++) {
      const v = validateWebhook(raw[idx]);
      if (!v.ok) {
        return res.status(400).json({ error: `第 ${idx + 1} 个 Webhook: ${v.error}` });
      }
      list.push(v.value);
    }
    updates.webhooks = list;
  }

  // webhook 全局项：对外地址 + 超时
  if (req.body.webhookPublicUrl !== undefined) {
    updates.webhookPublicUrl = String(req.body.webhookPublicUrl || '').trim().replace(/\/+$/, '');
    if (updates.webhookPublicUrl) {
      let u;
      try { u = new URL(updates.webhookPublicUrl); } catch { u = null; }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
        return res.status(400).json({ error: '对外访问地址无效，需为 http(s):// 开头的合法 URL' });
      }
    }
  }
  if (req.body.webhookTimeoutMs !== undefined) {
    const t = Number(req.body.webhookTimeoutMs);
    updates.webhookTimeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, 60000) : 10000;
  }
  // 下载令牌：留空 = 关闭（Jenkins 必须配这个才能调下载接口）
  if (req.body.downloadToken !== undefined) {
    updates.downloadToken = String(req.body.downloadToken || '').trim();
  }

  for (const key of PROXY_KEYS) {
    if (req.body[key] === undefined) continue;
    const raw = req.body[key] || {};
    const baseUrl = normalizeProxyBaseUrl(raw.baseUrl);
    const enabled = !!raw.enabled;

    if (enabled && !baseUrl) {
      const label = key === 'uploadProxy' ? '上传' : '下载';
      return res.status(400).json({ error: `${label}代理地址无效，需为 http(s):// 开头的合法 URL` });
    }

    updates[key] = { enabled, baseUrl };
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
  response.adminPasswordIsGenerated = !!getConfig('adminPasswordIsGenerated');
  // 计算出来的只读状态，让前端保存后立刻拿到最新值
  response.ipFilterEnabled = isIpFilterActive();

  const portChanged = updates.port !== undefined && updates.port !== oldPort;

  if (changedKeys.length > 0) {
    logger.log(`[管理] 设置已更新: ${changedKeys.join(', ')}`);
  }
  if (updates.adminPassword) {
    logger.log('[管理] 管理员密码已更改');
    // 改过之后就不再是「自动生成」状态，管理页据此不再显示首次登录提示
    updateConfig({ adminPasswordIsGenerated: false });
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
router.get('/stats', adminAuth, async (req, res) => {
  const stats = await getStats();
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

// 依赖工具体检：7z / clamscan 是否可用（Linux 上这两个缺失会让加密检测与杀毒静默失效）
// 放在 auth 之后，避免泄露服务器安装情况
router.get('/check-tools', adminAuth, (req, res) => {
  const status = checkToolStatus({
    sevenZipPath: getConfig('sevenZipPath'),
    unrarPath: getConfig('unrarPath'),
    clamscanPath: getConfig('clamscanPath'),
    enableVirusDetect: getConfig('enableVirusDetect'),
  });
  logger.log(`[管理] 依赖体检: 7z=${status.sevenZip.resolvedPath || '未找到'}, clamscan=${status.clamscan.resolvedPath || '未找到'}`);
  res.json(status);
});

module.exports = router;
