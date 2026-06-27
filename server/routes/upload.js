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
const { scanFile } = require('../services/avScan');
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

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    // Validate extensions
    for (const f of files) {
      if (!isExtensionAllowed(f.name)) {
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

    res.json({
      fileId,
      chunkSize: CHUNK_SIZE,
    });
  } catch (err) {
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
      return res.status(500).json({ error: '接收分块失败: ' + err.message });
    }

    // fileId is only available after multer parses the multipart form-data
    const fileId = req.body.fileId;
    if (!fileId) return res.status(400).json({ error: '缺少 fileId' });

    const config = getConfig();
    const folderPath = path.join(config.storagePath, fileId);
    if (!fs.existsSync(folderPath)) {
      return res.status(404).json({ error: '上传会话不存在，请重新开始' });
    }

    try {
      const fileIndex = parseInt(req.body.fileIndex, 10);
      const chunkIndex = parseInt(req.body.chunkIndex, 10);

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
      }

      res.json({
        fileIndex,
        chunkIndex,
        received: true,
      });
    } catch (err) {
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
    if (!fileId) return res.status(400).json({ error: '缺少 fileId' });

    const config = getConfig();
    const folderPath = path.join(config.storagePath, fileId);
    const chunksDir = path.join(folderPath, '.chunks');
    const manifestPath = path.join(chunksDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      return res.status(404).json({ error: '上传会话不存在' });
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    if (manifest.status === 'completed') {
      return res.status(400).json({ error: '上传已完成' });
    }

    // Reassemble each file from chunks
    const assembledFiles = [];
    for (let fi = 0; fi < manifest.files.length; fi++) {
      const fileInfo = manifest.files[fi];
      const totalChunks = Math.ceil(fileInfo.size / CHUNK_SIZE);

      // Verify all chunks received
      const received = manifest.receivedChunks?.[fi] || [];
      if (received.length < totalChunks) {
        return res.status(400).json({
          error: `文件 "${fileInfo.name}" 分块不完整 (已收到 ${received.length}/${totalChunks})`,
        });
      }

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
        const chunkPath = path.join(chunksDir, `${fi}_${ci}`);
        if (!fs.existsSync(chunkPath)) {
          writeStream.close();
          return res.status(400).json({ error: `缺少分块: ${fi}_${ci}` });
        }
        const chunkData = fs.readFileSync(chunkPath);
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

    // --- 压缩包检查 ---
    let archiveReport = null;
    try {
      archiveReport = inspectArchives(folderPath, {
        blockEncryptedArchives: config.blockEncryptedArchives,
        detectArchiveByContent: config.detectArchiveByContent,
        recursiveArchiveCheck: config.recursiveArchiveCheck,
        sevenZipPath: config.sevenZipPath,
      });
    } catch (err) {
      console.error(`[归档检查] 检查异常: ${err.message}`);
    }

    if (archiveReport && archiveReport.blocked) {
      // 阻止上传：清理已组装的文件和目录
      try { fs.rmSync(folderPath, { recursive: true }); } catch {}
      return res.status(400).json({
        error: `上传被阻止: ${archiveReport.blockReasons.join('; ')}`,
        blocked: true,
        reason: 'encrypted_archive',
        archiveResults: archiveReport.files,
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

    // Antivirus scan if enabled
    if (config.enableAntivirusScan) {
      scanFile(folderPath).catch(() => {});
    }

    manifest.status = 'completed';
    // Clean up manifest
    try {
      const mp = path.join(folderPath, '.chunks', 'manifest.json');
      if (fs.existsSync(mp)) fs.unlinkSync(mp);
      const cd = path.join(folderPath, '.chunks');
      if (fs.existsSync(cd)) fs.rmdirSync(cd);
    } catch {}

    res.json({
      success: true,
      fileId,
      fileCount: assembledFiles.length,
      expiresAt,
      message: `上传成功，文件 ID: ${fileId}`,
      archiveResults: archiveReport ? archiveReport.files : [],
    });
  } catch (err) {
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
