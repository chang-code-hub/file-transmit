const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getFileById } = require('../db');
const logger = require('../utils/logger');
const ipFilter = require('../middleware/ipFilter');

// Apply IP filter
router.use(ipFilter('download'));

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
    files: file.records.map(r => ({
      id: r.id,
      originalName: r.original_name,
      storedName: r.stored_name,
      size: r.size,
      mimeType: r.mime_type,
    })),
  });
});

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

  res.download(filePath, record.original_name);
});

module.exports = router;
