const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getConfig } = require('../config');
const { createFile, addFileRecord, getFileById, getFilesByUserId, validateFileIds } = require('../db');
const ipFilter = require('../middleware/ipFilter');
const logger = require('../utils/logger');

const { inspectArchives } = require('../services/archiveCheck');
const { resolvePublicOrigin, buildPayload, sendWebhooks } = require('../services/webhook');
const { normalizeSourceUrl, sanitizeFileName, resolveRemoteFile, downloadToFile } = require('../services/urlImport');
const { clientIpOf } = require('../utils/clientIp');

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

/**
 * 落盘文件名：去掉路径分隔符等危险字符，避免 ../ 穿出上传目录。
 * @param {string} name
 * @returns {string} 保证非空
 */
function diskSafeName(name) {
  return sanitizeFileName(name) || 'file';
}

/**
 * 生成不与已用名冲突的文件名：a.txt -> a (1).txt -> a (2).txt
 * @param {string} desired 用户/清单里的名字
 * @param {string[]} taken 已占用的 storedName 列表
 */
function uniqueStoredName(desired, taken) {
  const base = diskSafeName(desired);
  const dotIdx = base.lastIndexOf('.');
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 ? base.slice(dotIdx) : '';
  let name = base;
  let counter = 1;
  while (taken.includes(name)) {
    name = `${stem} (${counter})${ext}`;
    counter++;
  }
  return name;
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
 * POST /api/upload/url/resolve
 * 探测一个互联网链接，把文件名 / 大小 / MIME 解析出来给前端回填。
 * Body: { url }
 *
 * 只读响应头、不下载正文，所以失败也很快；前端拿不到时仍可用 URL 自己猜个名字。
 */
router.post('/url/resolve', async (req, res) => {
  const clientIp = clientIpOf(req);
  try {
    const rawUrl = req.body && req.body.url;
    let info;
    try {
      info = await resolveRemoteFile(rawUrl);
    } catch (err) {
      logger.log(`[链接导入] 解析失败: "${String(rawUrl || '').slice(0, 200)}" ${err.message}, IP=${clientIp}`);
      return res.status(400).json({ error: err.message });
    }

    const allowed = isExtensionAllowed(info.fileName);
    logger.log(
      `[链接导入] 解析成功: 文件名="${info.fileName}", 大小=${info.size || '未知'}, ` +
      `类型=${allowed ? '允许' : '不在白名单'}, IP=${clientIp}`
    );
    res.json({ ...info, extensionAllowed: allowed });
  } catch (err) {
    logger.error(`[链接导入] 解析异常: ${err.message}`);
    res.status(500).json({ error: '解析链接失败: ' + err.message });
  }
});

/**
 * POST /api/upload/init
 * Initialize an upload session. Creates fileId folder and returns uploadId.
 * Body: { files: [{name, size, mimeType, sourceUrl?, host?}], description }
 */
router.post('/init', (req, res) => {
  try {
    const { files, description } = req.body;
    const clientIp = clientIpOf(req);

    if (!files || !Array.isArray(files) || files.length === 0) {
      logger.log(`[上传] 初始化请求无效: 未提供文件列表, IP=${clientIp}`);
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    // Validate extensions + 互联网链接条目
    for (const f of files) {
      if (!f || typeof f.name !== 'string' || !f.name.trim()) {
        logger.log('[上传] 初始化被拒绝: 存在没有文件名的条目');
        return res.status(400).json({ error: '存在没有文件名的条目' });
      }
      if (!isExtensionAllowed(f.name)) {
        logger.log(`[上传] 初始化被拒绝: 不允许的文件类型 "${f.name}", IP=${clientIp}`);
        return res.status(400).json({ error: `不允许的文件类型: ${path.extname(f.name)}` });
      }
      if (f.sourceUrl) {
        try {
          normalizeSourceUrl(f.sourceUrl);
        } catch (err) {
          logger.log(`[上传] 初始化被拒绝: 链接无效 "${String(f.sourceUrl).slice(0, 200)}" (${err.message}), IP=${clientIp}`);
          return res.status(400).json({ error: `链接无效：${err.message}` });
        }
      }
    }

    // 归一化清单条目：链接条目额外记下 sourceUrl 与是否托管
    const manifestFiles = files.map((f) => {
      const entry = {
        name: String(f.name).trim(),
        size: Number(f.size) || 0,
        mimeType: String(f.mimeType || ''),
      };
      if (f.sourceUrl) {
        entry.sourceUrl = String(f.sourceUrl).trim();
        // 只有显式传 false 才算「不托管」，缺省一律托管（有实体文件才好做归档/病毒检查）
        entry.host = f.host !== false;
      }
      return entry;
    });

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
      files: manifestFiles,
      createdAt: Date.now(),
      status: 'uploading',
    };
    fs.writeFileSync(
      path.join(chunksDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    const totalSize = manifestFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    const urlCount = manifestFiles.filter((f) => f.sourceUrl).length;
    logger.log(
      `[上传] 初始化成功: ID=${fileId}, 文件数=${manifestFiles.length}` +
      `${urlCount ? `（含 ${urlCount} 个链接条目）` : ''}, 总大小=${(totalSize / 1024 / 1024).toFixed(1)}MB, IP=${clientIp}`
    );

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
 * 上传完成后发 webhook（fire-and-forget）。
 * 重新读库拿到刚写入的文件行与附件记录，组装负载后异步发送；
 * 未配置或发送失败都只记日志，不影响上传结果。
 *
 * @param {object} p
 * @param {string} p.fileId
 * @param {Array}  p.succeededFiles
 * @param {Array}  p.failedFiles
 * @param {object} p.req
 */
async function notifyWebhook({ fileId, succeededFiles, failedFiles, req }) {
  try {
    const list = getConfig('webhooks') || [];
    if (!list.some((w) => w && w.enabled && String(w.url || '').trim())) return;

    const row = await getFileById(fileId);
    if (!row) return;

    const payload = buildPayload({
      file: row,
      records: row.records || [],
      succeededFiles,
      failedFiles,
      origin: resolvePublicOrigin(req),
      config: getConfig(),
      req,
    });
    // 并发广播到所有已启用的 webhook；单个失败只记日志，不影响其它，也不影响响应
    await sendWebhooks(payload);
  } catch (err) {
    logger.error(`[Webhook] 发送异常: ID=${fileId}, ${err.message}`);
  }
}

/**
 * POST /api/upload/complete
 * Reassemble all chunks into final files, create DB records, run AV scan.
 * Body: { fileId }
 */
router.post('/complete', async (req, res) => {
  try {
    const { fileId } = req.body;
    const clientIp = clientIpOf(req);
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
    // 链接条目（sourceUrl）不走分块：托管的由服务器现取，不托管的只写跳转记录。
    const assembledFiles = [];
    const skippedFiles = [];
    const takenNames = [];
    for (let fi = 0; fi < manifest.files.length; fi++) {
      const fileInfo = manifest.files[fi];

      // --- 互联网链接导入 ---
      if (fileInfo.sourceUrl) {
        const storedName = uniqueStoredName(fileInfo.name, takenNames);
        const originalName = diskSafeName(fileInfo.name);
        const finalPath = path.join(folderPath, storedName);

        if (fileInfo.host === false) {
          // 不托管：本地不落任何字节，下载时 302 回原始链接。
          // size 记 0 —— 这一列全系统都当「实际落地的字节数」用（统计、webhook 合计），
          // 远端大小只在添加时给用户看，不写进库。
          takenNames.push(storedName);
          assembledFiles.push({
            originalName,
            storedName,
            size: 0,
            mimeType: fileInfo.mimeType || '',
            sourceUrl: fileInfo.sourceUrl,
            hosted: false,
          });
          logger.log(`[上传] 链接条目(跳转): ID=${fileId}, 文件="${originalName}" -> ${fileInfo.sourceUrl}`);
          continue;
        }

        // 托管：服务器下载到本地，之后照常走归档检查 / 病毒检测
        try {
          const dl = await downloadToFile(fileInfo.sourceUrl, finalPath);
          takenNames.push(storedName);
          assembledFiles.push({
            originalName,
            storedName,
            size: dl.size,
            mimeType: dl.mimeType || fileInfo.mimeType || '',
            sourceUrl: fileInfo.sourceUrl,
            hosted: true,
          });
          logger.log(
            `[上传] 链接条目(托管): ID=${fileId}, 文件="${originalName}", ` +
            `大小=${(dl.size / 1024 / 1024).toFixed(1)}MB, IP=${clientIp}`
          );
        } catch (err) {
          logger.error(`[上传] 链接下载失败: ID=${fileId}, 文件="${fileInfo.name}", URL=${fileInfo.sourceUrl}, ${err.message}`);
          try { fs.rmSync(finalPath, { force: true }); } catch {}
          skippedFiles.push({ name: fileInfo.name, reason: `链接下载失败: ${err.message}` });
        }
        continue;
      }

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

      // Handle duplicate filenames（顺带把路径分隔符等危险字符挡在磁盘之外）
      const storedName = uniqueStoredName(fileInfo.name, takenNames);
      takenNames.push(storedName);

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

    // 如果没有一个文件落地成功，返回错误
    if (assembledFiles.length === 0) {
      logger.log(`[上传] 完成失败: ID=${fileId}, 所有文件均未成功（分块不完整或链接下载失败）`);
      try { fs.rmSync(folderPath, { recursive: true }); } catch {}
      return res.status(400).json({ error: skippedFiles[0]?.reason || '所有文件上传均不完整，请重试' });
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
        clamscanPath: config.clamscanPath,
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
    const ip = clientIp;

    await createFile({
      id: fileId,
      folderPath,
      description: manifest.description,
      ip,
      ua: req.headers['user-agent'] || '',
      userId: req.userId,
      expiresAt,
    });

    for (const f of assembledFiles) {
      await addFileRecord({
        fileId,
        originalName: f.originalName,
        storedName: f.storedName,
        size: f.size,
        mimeType: f.mimeType,
        sourceUrl: f.sourceUrl || '',
        hosted: f.hosted !== false,
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
      ? `，${skippedFiles.length} 个文件被跳过（分块缺失或链接下载失败）`
      : '';
    const redirectCount = assembledFiles.filter(f => f.hosted === false).length;
    logger.log(`[上传] 完成: ID=${fileId}, 文件数=${assembledFiles.length}${skippedInfo}${redirectCount ? `，其中 ${redirectCount} 个为外链跳转` : ''}, 总大小=${(totalSize / 1024 / 1024).toFixed(1)}MB, IP=${ip}, 保留至=${new Date(expiresAt).toLocaleString()}`);

    const succeededPayload = assembledFiles.map(f => ({
      name: f.originalName,
      size: f.size,
      sourceUrl: f.sourceUrl || '',
      hosted: f.hosted !== false,
    }));

    res.json({
      success: true,
      fileId,
      fileCount: assembledFiles.length,
      totalCount: manifest.files.length,
      succeededFiles: succeededPayload,
      failedFiles: skippedFiles.length > 0 ? skippedFiles : [],
      expiresAt,
      message: skippedFiles.length > 0
        ? `上传部分成功（${assembledFiles.length}/${manifest.files.length}），文件 ID: ${fileId}`
        : `上传成功，文件 ID: ${fileId}`,
      archiveResults: archiveReport ? archiveReport.files : [],
    });

    // Webhook：上传成功后广播给所有已启用的 webhook，带文件 ID + 附件清单（含下载链接）。
    // 必须放在 res.json 之后、且不 await —— 回调慢/挂掉都不能拖住上传响应。
    notifyWebhook({
      fileId,
      succeededFiles: succeededPayload,
      failedFiles: skippedFiles.length > 0 ? skippedFiles : [],
      req,
    });
  } catch (err) {
    logger.error(`[上传] 完成失败: ${err.message}`);
    res.status(500).json({ error: '完成上传失败: ' + err.message });
  }
});

// Get user's upload history
router.get('/history', async (req, res) => {
  const files = await getFilesByUserId(req.userId);
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
      sourceUrl: r.source_url || '',
      hosted: r.hosted !== false,
    })),
  })));
});

// Validate which file IDs still exist (for localStorage cleanup)
router.get('/validate-ids', async (req, res) => {
  const idsParam = req.query.ids;
  if (!idsParam) return res.json({ validIds: [] });

  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  const validIds = await validateFileIds(ids);
  res.json({ validIds });
});

module.exports = router;
