const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getConfig } = require('../config');
const { createFile, addFileRecord, getFilesByUserId, validateFileIds } = require('../db');
const ipFilter = require('../middleware/ipFilter');
const logger = require('../utils/logger');

const { inspectArchives } = require('../services/archiveCheck');

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB per chunk

// Apply IP filter
router.use(ipFilter('upload'));

// Generate random 8-char uppercase alphanumeric ID
function generateId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

// Check if file extension is allowed
function isExtensionAllowed(filename) {
  const config = getConfig();
  const types = config.allowedFileTypes;
  const ext = path.extname(filename).toLowerCase();
  if (!types) return true;

  const allAllowed = [
    ...(types.documents || []),
    ...(types.images || []),
    ...(types.archives || []),
    ...(types.videos || []),
    ...(types.audio || []),
    ...(types.code || []),
    ...(types.custom || []),
  ];
  if (allAllowed.length === 0) return true;
  return allAllowed.some(allowed => allowed.toLowerCase() === ext);
}

// Multer for chunk uploads — store in temp chunks dir
const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const config = getConfig();
      const chunksDir = path.join(config.storagePath, req.body.fileId, '.chunks');
      if (!fs.existsSync(chunksDir)) {
        fs.mkdirSync(chunksDir, { recursive: true });
      }
      cb(null, chunksDir);
    },
    filename: (req, file, cb) => {
      // Name chunks as: fileIndex_chunkIndex
      cb(null, `${req.body.fileIndex}_${req.body.chunkIndex}`);
    },
  }),
  limits: { fileSize: CHUNK_SIZE + 1024 * 1024 }, // chunk + overhead
});

/**
 * POST /api/upload/init
 * Initialize an upload session. Creates fileId folder and returns uploadId.
 * Body: { files: [{name, size, mimeType}], description }
 */
router.post('/init', (req, res) => {
  try {
    const { files, description } = req.body;
    const clientIp = (req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');

    if (!files || !Array.isArray(files) || files.length === 0) {
      logger.log(`[上传] 初始化请求无效: 未提供文件列表, IP=${clientIp}`);
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    // Validate extensions
    for (const f of files) {
      if (!isExtensionAllowed(f.name)) {
        logger.log(`[上传] 初始化被拒绝: 不允许的文件类型 "${f.name}", IP=${clientIp}`);
        return res.status(400).json({ error: `不允许的文件类型: ${path.extname(f.name)}` });
      }
    }

    // Generate fileId and ensure unique folder
    let fileId;
    let folderPath;
    const config = getConfig();
    do {
      fileId = generateId();
      folderPath = path.join(config.storagePath, fileId);
    } while (fs.existsSync(folderPath));

    fs.mkdirSync(folderPath, { recursive: true });

    // Create .chunks subdirectory for chunk storage
    const chunksDir = path.join(folderPath, '.chunks');
    fs.mkdirSync(chunksDir, { recursive: true });

    // Save upload manifest
    const manifest = {
      fileId,
      description: description || '',
      files,
      createdAt: Date.now(),
      status: 'uploading',
    };
    fs.writeFileSync(
      path.join(chunksDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    logger.log(`[上传] 初始化成功: ID=${fileId}, 文件数=${files.length}, 总大小=${(totalSize / 1024 / 1024).toFixed(1)}MB, IP=${clientIp}`);

    res.json({
      fileId,
      chunkSize: CHUNK_SIZE,
    });
  } catch (err) {
    logger.error(`[上传] 初始化失败: ${err.message}`);
    res.status(500).json({ error: '初始化上传失败: ' + err.message });
  }
});

/**
 * POST /api/upload/chunk
 * Upload a single chunk of a file.
 * FormData: fileId, fileIndex, chunkIndex, totalChunks, chunk (file)
 */
router.post('/chunk', (req, res) => {
  chunkUpload.single('chunk')(req, res, (err) => {
    if (err) {
      logger.error(`[上传] 接收分块失败: ${err.message}`);
      return res.status(500).json({ error: '接收分块失败: ' + err.message });
    }

    // fileId is only available after multer parses the multipart form-data
    const fileId = req.body.fileId;
    if (!fileId) {
      logger.log('[上传] 分块请求缺少 fileId');
      return res.status(400).json({ error: '缺少 fileId' });
    }

    const config = getConfig();
    const folderPath = path.join(config.storagePath, fileId);
    if (!fs.existsSync(folderPath)) {
      logger.log(`[上传] 分块请求无效: 会话不存在 ID=${fileId}`);
      return res.status(404).json({ error: '上传会话不存在，请重新开始' });
    }

    try {
      const fileIndex = parseInt(req.body.fileIndex, 10);
      const chunkIndex = parseInt(req.body.chunkIndex, 10);
      const totalChunks = parseInt(req.body.totalChunks, 10);

      // Update manifest to track received chunks
      const manifestPath = path.join(folderPath, '.chunks', 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (!manifest.receivedChunks) manifest.receivedChunks = {};
        if (!manifest.receivedChunks[fileIndex]) manifest.receivedChunks[fileIndex] = [];
        if (!manifest.receivedChunks[fileIndex].includes(chunkIndex)) {
          manifest.receivedChunks[fileIndex].push(chunkIndex);
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

        // Log first and last chunk per file
        if (chunkIndex === 0) {
          logger.log(`[上传] 开始接收文件: ID=${fileId}, 文件索引=${fileIndex}, 总分块=${totalChunks}`);
        }
        const received = manifest.receivedChunks[fileIndex].length;
        if (received === totalChunks) {
          logger.log(`[上传] 文件分块接收完毕: ID=${fileId}, 文件索引=${fileIndex}, 分块数=${totalChunks}`);
        }
      }

      res.json({
        fileIndex,
        chunkIndex,
        received: true,
      });
    } catch (err) {
      logger.error(`[上传] 处理分块失败: ID=${fileId}, ${err.message}`);
      res.status(500).json({ error: '处理分块失败: ' + err.message });
    }
  });
});

/**
 * POST /api/upload/complete
 * Reassemble all chunks into final files, create DB records, run AV scan.
 * Body: { fileId }
 */
router.post('/complete', async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!fileId) {
      logger.log('[上传] 完成请求缺少 fileId');
      return res.status(400).json({ error: '缺少 fileId' });
    }

    const config = getConfig();
    const folderPath = path.join(config.storagePath, fileId);
    const chunksDir = path.join(folderPath, '.chunks');
    const manifestPath = path.join(chunksDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      logger.log(`[上传] 完成请求无效: 会话不存在 ID=${fileId}`);
      return res.status(404).json({ error: '上传会话不存在' });
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    if (manifest.status === 'completed') {
      logger.log(`[上传] 完成请求重复: ID=${fileId}`);
      return res.status(400).json({ error: '上传已完成' });
    }

    // Reassemble each file from chunks
    // 跳过不完整的文件（部分分块可能因为客户端网络问题未到达）
    const assembledFiles = [];
    const skippedFiles = [];
    for (let fi = 0; fi < manifest.files.length; fi++) {
      const fileInfo = manifest.files[fi];
      const totalChunks = Math.ceil(fileInfo.size / CHUNK_SIZE);

      // Verify all chunks received
      const received = manifest.receivedChunks?.[fi] || [];
      if (received.length < totalChunks) {
        logger.log(`[上传] 跳过不完整文件: ID=${fileId}, 文件="${fileInfo.name}" 分块不完整 (${received.length}/${totalChunks})`);
        skippedFiles.push({ name: fileInfo.name, reason: '分块不完整' });
        continue;
      }

      // Verify each chunk file exists on disk
      let allChunksExist = true;
      for (let ci = 0; ci < totalChunks; ci++) {
        if (!fs.existsSync(path.join(chunksDir, `${fi}_${ci}`))) {
          logger.log(`[上传] 跳过文件: ID=${fileId}, 文件="${fileInfo.name}" 缺少分块 ${ci}/${totalChunks}`);
          skippedFiles.push({ name: fileInfo.name, reason: `缺少分块 ${ci}` });
          allChunksExist = false;
          break;
        }
      }
      if (!allChunksExist) continue;

      // Handle duplicate filenames
      let storedName = fileInfo.name;
      let counter = 1;
      while (assembledFiles.some(f => f.storedName === storedName)) {
        const dotIdx = fileInfo.name.lastIndexOf('.');
        if (dotIdx > 0) {
          storedName = fileInfo.name.slice(0, dotIdx) + ` (${counter})` + fileInfo.name.slice(dotIdx);
        } else {
          storedName = fileInfo.name + ` (${counter})`;
        }
        counter++;
      }

      // Write chunks sequentially into final file
      const finalPath = path.join(folderPath, storedName);
      const writeStream = fs.createWriteStream(finalPath);

      for (let ci = 0; ci < totalChunks; ci++) {
        const chunkData = fs.readFileSync(path.join(chunksDir, `${fi}_${ci}`));
        writeStream.write(chunkData);
      }

      await new Promise((resolve, reject) => {
        writeStream.end((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      assembledFiles.push({
        originalName: fileInfo.name,
        storedName,
        size: fileInfo.size,
        mimeType: fileInfo.mimeType || '',
      });
    }

    // 如果没有一个文件组装成功，返回错误
    if (assembledFiles.length === 0) {
      logger.log(`[上传] 完成失败: ID=${fileId}, 所有文件分块均不完整`);
      try { fs.rmSync(folderPath, { recursive: true }); } catch {}
      return res.status(400).json({ error: '所有文件上传均不完整，请重试' });
    }

    // --- 压缩包检查（含病毒检测） ---
    let archiveReport = null;
    try {
      archiveReport = await inspectArchives(folderPath, {
        blockEncryptedArchives: config.blockEncryptedArchives,
        detectArchiveByContent: config.detectArchiveByContent,
        recursiveArchiveCheck: config.recursiveArchiveCheck,
        sevenZipPath: config.sevenZipPath,
        enableVirusDetect: config.enableVirusDetect,
      });
    } catch (err) {
      logger.error(`[归档检查] 检查异常: ${err.message}`);
    }

    if (archiveReport && archiveReport.blocked) {
      logger.log(`[上传] 被归档检查阻止: ID=${fileId}, 原因=${archiveReport.blockReasons.join('; ')}`);
      // 阻止上传：清理已组装的文件和目录
      try { fs.rmSync(folderPath, { recursive: true }); } catch {}
      return res.status(400).json({
        error: `上传被阻止: ${archiveReport.blockReasons.join('; ')}`,
        blocked: true,
        reason: 'encrypted_archive',
        archiveResults: archiveReport.files,
      });
    }

    // --- 病毒检测结果检查（由 archiveCheck 解压时执行） ---
    if (archiveReport && archiveReport.virusDetected) {
      const { virusBeforeCount, virusAfterCount, virusMissing } = archiveReport;
      logger.log(`[上传] 病毒检测发现异常: ID=${fileId}, 文件减少 ${virusMissing} 个 (${virusBeforeCount}→${virusAfterCount})`);
      try { fs.rmSync(folderPath, { recursive: true }); } catch {}
      return res.status(400).json({
        error: `文件安全检查未通过：疑似杀毒软件删除了可疑文件，上传已被拒绝`,
        blocked: true,
        reason: 'virus_detected',
        virusResult: {
          extractedCount: virusBeforeCount,
          remainingCount: virusAfterCount,
          missingCount: virusMissing,
        },
      });
    }

    // Clean up chunks directory
    try { fs.rmSync(chunksDir, { recursive: true }); } catch {}

    // Create DB records
    const retentionHours = config.retentionHours || 24;
    const expiresAt = Date.now() + retentionHours * 60 * 60 * 1000;
    const clientIp = req.ip || req.connection.remoteAddress || '';
    const ip = clientIp.replace(/^::ffff:/, '');

    createFile({
      id: fileId,
      folderPath,
      description: manifest.description,
      ip,
      ua: req.headers['user-agent'] || '',
      userId: req.userId,
      expiresAt,
    });

    for (const f of assembledFiles) {
      addFileRecord({
        fileId,
        originalName: f.originalName,
        storedName: f.storedName,
        size: f.size,
        mimeType: f.mimeType,
      });
    }

    manifest.status = 'completed';
    // Clean up manifest
    try {
      const mp = path.join(folderPath, '.chunks', 'manifest.json');
      if (fs.existsSync(mp)) fs.unlinkSync(mp);
      const cd = path.join(folderPath, '.chunks');
      if (fs.existsSync(cd)) fs.rmdirSync(cd);
    } catch {}

    const totalSize = assembledFiles.reduce((sum, f) => sum + f.size, 0);
    const skippedInfo = skippedFiles.length > 0
      ? `，${skippedFiles.length} 个文件因分块缺失被跳过`
      : '';
    logger.log(`[上传] 完成: ID=${fileId}, 文件数=${assembledFiles.length}${skippedInfo}, 总大小=${(totalSize / 1024 / 1024).toFixed(1)}MB, IP=${ip}, 保留至=${new Date(expiresAt).toLocaleString()}`);

    res.json({
      success: true,
      fileId,
      fileCount: assembledFiles.length,
      totalCount: manifest.files.length,
      succeededFiles: assembledFiles.map(f => ({ name: f.originalName, size: f.size })),
      failedFiles: skippedFiles.length > 0 ? skippedFiles : [],
      expiresAt,
      message: skippedFiles.length > 0
        ? `上传部分成功（${assembledFiles.length}/${manifest.files.length}），文件 ID: ${fileId}`
        : `上传成功，文件 ID: ${fileId}`,
      archiveResults: archiveReport ? archiveReport.files : [],
    });
  } catch (err) {
    logger.error(`[上传] 完成失败: ${err.message}`);
    res.status(500).json({ error: '完成上传失败: ' + err.message });
  }
});

// Get user's upload history
router.get('/history', (req, res) => {
  const files = getFilesByUserId(req.userId);
  res.json(files.map(f => ({
    id: f.id,
    description: f.description,
    createdAt: f.created_at,
    expiresAt: f.expires_at,
    fileCount: f.records.length,
    files: f.records.map(r => ({
      originalName: r.original_name,
      size: r.size,
      mimeType: r.mime_type,
    })),
  })));
});

// Validate which file IDs still exist (for localStorage cleanup)
router.get('/validate-ids', (req, res) => {
  const idsParam = req.query.ids;
  if (!idsParam) return res.json({ validIds: [] });

  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  const validIds = validateFileIds(ids);
  res.json({ validIds });
});

module.exports = router;
