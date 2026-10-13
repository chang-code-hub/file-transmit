const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { getFileById } = require('../db');
const { isDownloadProxyEnabled } = require('../config');
const logger = require('../utils/logger');
const ipFilter = require('../middleware/ipFilter');

// Apply IP filter
router.use(ipFilter('download'));

/**
 * 构造下载链接。代理模式由 middleware/proxy.js 统一转发 /api，
 * 因此这里始终返回本机相对路径。
 */
function buildDownloadUrl(fileId, fileName) {
  return `/api/download/${encodeURIComponent(fileId)}/${encodeURIComponent(fileName)}`;
}

/** 打包下载链接 */
function buildZipUrl(fileId) {
  return `/api/download/${encodeURIComponent(fileId)}/zip`;
}

/** 文件名写入 zip entry 时做安全处理，防止路径穿越 */
function zipEntryName(name) {
  return String(name).replace(/[\/]/g, '_').replace(/^[.\s]+/, '_') || 'file';
}

/** RFC 5987 编码，兼容中文/特殊字符的 Content-Disposition */
function contentDisposition(filename) {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

// Get file detail by ID
router.get('/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const clientIp = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');

  if (!fileId || fileId.length !== 8) {
    logger.log(`[下载] 查询详情请求无效: 非法ID="${fileId}", IP=${clientIp}`);
    return res.status(400).json({ error: '无效的文件 ID，文件 ID 为 8 位字符' });
  }

  const file = await getFileById(fileId);

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
    zipUrl: buildZipUrl(file.id),
    fileCount: file.records.length,
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
 * GET /api/download/:fileId/zip
 * 打包下载：把该 ID 下的全部文件压成 zip 流式返回。
 * 支持 ?files=a,b 指定 storedName / originalName 子集（逗号分隔）。
 */
router.get('/:fileId/zip', async (req, res) => {
  const { fileId } = req.params;
  const clientIp = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');

  const file = await getFileById(fileId);

  if (!file) {
    logger.log(`[下载] 打包下载: ID=${fileId} 不存在或已过期, IP=${clientIp}`);
    return res.status(404).json({ error: '文件不存在或已过期' });
  }

  if (Date.now() > file.expires_at) {
    logger.log(`[下载] 打包下载: ID=${fileId} 已过期, IP=${clientIp}`);
    return res.status(410).json({ error: '文件已过期' });
  }

  // 可选子集：?files=storedName1,storedName2
  let records = file.records;
  const only = String(req.query.files || '').split(',').map(s => s.trim()).filter(Boolean);
  if (only.length > 0) {
    const wanted = new Set(only);
    records = file.records.filter(r => wanted.has(r.stored_name) || wanted.has(r.original_name));
    if (records.length === 0) {
      logger.log(`[下载] 打包下载: ID=${fileId} 指定文件均不存在, IP=${clientIp}`);
      return res.status(404).json({ error: '指定的文件不存在' });
    }
  }

  // 去掉已从磁盘删除的文件
  const existing = records.filter(r => fs.existsSync(path.join(file.folder_path, r.stored_name)));
  if (existing.length === 0) {
    logger.log(`[下载] 打包下载: ID=${fileId} 无可下载文件, IP=${clientIp}`);
    return res.status(404).json({ error: '文件已被删除' });
  }

  const zipName = `${fileId}.zip`;
  const totalMB = (existing.reduce((s, r) => s + (r.size || 0), 0) / 1024 / 1024).toFixed(1);
  logger.log(`[下载] 开始打包下载: ID=${fileId}, 文件数=${existing.length}, 合计=${totalMB}MB, IP=${clientIp}`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(zipName));

  // forceZip64/UTF-8: 中文等非 ASCII 文件名在 zip 里以 UTF-8 存储并置标志位，
  // 否则 Windows 资源管理器/部分解压工具会显示乱码
  const archive = archiver('zip', { zlib: { level: 6 }, forceZip64: true });

  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') logger.warn(`[下载] 打包警告: ID=${fileId}: ${err.message}`);
    else logger.error(`[下载] 打包出错: ID=${fileId}: ${err.message}`);
  });

  archive.on('error', (err) => {
    logger.error(`[下载] 打包失败: ID=${fileId}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: '打包下载失败: ' + err.message });
    else res.destroy(err);
  });

  // archiver -> 客户端，流式输出，不落临时文件
  archive.pipe(res);

  // zip 内重名时加序号
  const used = new Set();
  for (const r of existing) {
    let name = zipEntryName(r.original_name || r.stored_name);
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 1;
      while (used.has(`${stem} (${n})${ext}`)) n++;
      name = `${stem} (${n})${ext}`;
    }
    used.add(name);
    archive.file(path.join(file.folder_path, r.stored_name), { name });
  }

  await archive.finalize();
});

// Download a specific file
router.get('/:fileId/:fileName', async (req, res) => {
  const { fileId, fileName } = req.params;
  const clientIp = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');

  const file = await getFileById(fileId);

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
module.exports.buildDownloadUrl = buildDownloadUrl;
module.exports.buildZipUrl = buildZipUrl;
