const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getFileById } = require('../db');
const logger = require('../utils/logger');
const ipFilter = require('../middleware/ipFilter');
const { getConfig, normalizeProxyBaseUrl, isDownloadProxyEnabled } = require('../config');

// Apply IP filter
router.use(ipFilter('download'));

/**
 * Build the download URL for one file under a download ID.
 * When 下载代理 is enabled the path is rewritten to the configured
 * external prefix (e.g. http://nexusoss.org/repository/download/),
 * otherwise the local /api/download/ endpoint is used.
 */
function buildDownloadUrl(fileId, fileName) {
  const base = normalizeProxyBaseUrl(getConfig('downloadProxy')?.baseUrl);
  const encodedFileId = encodeURIComponent(fileId);
  const encodedFileName = encodeURIComponent(fileName);

  if (isDownloadProxyEnabled() && base) {
    return `${base}/${encodedFileId}/${encodedFileName}`;
  }
  return `/api/download/${encodedFileId}/${encodedFileName}`;
}

// Get file detail by ID
router.get('/:fileId', (req, res) => {
  const { fileId } = req.params;
  const clientIp = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');

  if (!fileId || fileId.length !== 8) {
    logger.log(`[下载] 查询详情请求无效: 非法ID="${fileId}", IP=${clientIp}`);
    return res.status(400).json({ error: '无效的文件 ID，文件 ID 为 8 位字符' });
  }

  const file = getFileById(fileId);

  if (!file) {
    logger.log(`[下载] 查询详情: ID=${fileId} 不存在或已过期, IP=${clientIp}`);
    return res.status(404).json({ error: '文件不存在或已过期' });
  }

  // Check if expired
  if (Date.now() > file.expires_at) {
    logger.log(`[下载] 查询详情: ID=${fileId} 已过期, IP=${clientIp}`);
    return res.status(410).json({ error: '文件已过期' });
  }

  logger.log(`[下载] 查询详情: ID=${fileId}, 文件数=${file.records.length}, IP=${clientIp}`);

  res.json({
    id: file.id,
    description: file.description,
    createdAt: file.created_at,
    expiresAt: file.expires_at,
    uploaderIp: file.uploader_ip,
    userAgent: file.uploader_ua,
    downloadProxyEnabled: isDownloadProxyEnabled(),
    files: file.records.map(r => ({
      id: r.id,
      originalName: r.original_name,
      storedName: r.stored_name,
      size: r.size,
      mimeType: r.mime_type,
      downloadUrl: buildDownloadUrl(file.id, r.stored_name),
    })),
  });
});

/**
 * Build the download URL for one file under a download ID.
 * When 下载代理 is enabled the path is rewritten to the configured
 * external prefix (e.g. http://nexusoss.org/repository/download/),
 * otherwise the local /api/download/ endpoint is used.
 */
function buildDownloadUrl(fileId, fileName) {
  const base = normalizeProxyBaseUrl(getConfig('downloadProxy')?.baseUrl);
  const encodedFileId = encodeURIComponent(fileId);
  const encodedFileName = encodeURIComponent(fileName);

  if (isDownloadProxyEnabled() && base) {
    return `${base}/${encodedFileId}/${encodedFileName}`;
  }
  return `/api/download/${encodedFileId}/${encodedFileName}`;
}

// Download a specific file
router.get('/:fileId/:fileName', (req, res) => {
  const { fileId, fileName } = req.params;
  const clientIp = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');

  const file = getFileById(fileId);

  if (!file) {
    logger.log(`[下载] 下载请求: ID=${fileId} 不存在或已过期, IP=${clientIp}`);
    return res.status(404).json({ error: '文件不存在或已过期' });
  }

  if (Date.now() > file.expires_at) {
    logger.log(`[下载] 下载请求: ID=${fileId} 已过期, IP=${clientIp}`);
    return res.status(410).json({ error: '文件已过期' });
  }

  const record = file.records.find(r => r.stored_name === fileName || r.original_name === fileName);

  if (!record) {
    logger.log(`[下载] 下载请求: ID=${fileId}, 文件 "${fileName}" 不存在, IP=${clientIp}`);
    return res.status(404).json({ error: '文件不存在' });
  }

  const filePath = path.join(file.folder_path, record.stored_name);

  if (!fs.existsSync(filePath)) {
    logger.log(`[下载] 下载请求: ID=${fileId}, 文件 "${record.stored_name}" 已被删除, IP=${clientIp}`);
    return res.status(404).json({ error: '文件已被删除' });
  }

  const sizeMB = (record.size / 1024 / 1024).toFixed(1);
  logger.log(`[下载] 开始下载: ID=${fileId}, 文件="${record.original_name}", 大小=${sizeMB}MB, IP=${clientIp}`);

  // 下载代理：将 /api/download/:id/:name 重定向到外部代理路径
  if (isDownloadProxyEnabled()) {
    const target = buildDownloadUrl(fileId, record.stored_name);
    logger.log(`[下载] 代理转发: ID=${fileId}, 文件="${record.original_name}", 目标=${target}`);
    return res.redirect(302, target);
  }

  res.download(filePath, record.original_name);
});

module.exports = router;
module.exports.buildDownloadUrl = buildDownloadUrl;
