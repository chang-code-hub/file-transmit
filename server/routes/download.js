const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getFileById } = require('../db');
const ipFilter = require('../middleware/ipFilter');

// Apply IP filter
router.use(ipFilter('download'));

// Get file detail by ID
router.get('/:fileId', (req, res) => {
  const { fileId } = req.params;

  if (!fileId || fileId.length !== 8) {
    return res.status(400).json({ error: '无效的文件 ID，文件 ID 为 8 位字符' });
  }

  const file = getFileById(fileId);

  if (!file) {
    return res.status(404).json({ error: '文件不存在或已过期' });
  }

  // Check if expired
  if (Date.now() > file.expires_at) {
    return res.status(410).json({ error: '文件已过期' });
  }

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

  const file = getFileById(fileId);

  if (!file) {
    return res.status(404).json({ error: '文件不存在或已过期' });
  }

  if (Date.now() > file.expires_at) {
    return res.status(410).json({ error: '文件已过期' });
  }

  const record = file.records.find(r => r.stored_name === fileName || r.original_name === fileName);

  if (!record) {
    return res.status(404).json({ error: '文件不存在' });
  }

  const filePath = path.join(file.folder_path, record.stored_name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件已被删除' });
  }

  res.download(filePath, record.original_name);
});

module.exports = router;
