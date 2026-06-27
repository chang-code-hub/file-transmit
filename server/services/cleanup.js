const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { getConfig } = require('../config');
const {
  deleteExpiredFiles,
  getAllFileRecords,
  deleteFileRecordById,
  getAllFiles,
  deleteFileById,
} = require('../db');

const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes

function removeEmptyDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subPath = path.join(dirPath, entry.name);
      removeEmptyDirs(subPath);

      // Check if directory is now empty
      try {
        const remaining = fs.readdirSync(subPath);
        if (remaining.length === 0) {
          fs.rmdirSync(subPath);
          logger.log(`[清理] 删除空目录: ${subPath}`);
        }
      } catch {}
    }
  }
}

function runCleanup() {
  try {
    logger.log('[清理] 开始执行清理任务...');
    const now = Date.now();

    // 1. Delete expired DB records + their folders
    const expired = deleteExpiredFiles(now);
    logger.log(`[清理] 删除 ${expired.length} 条过期记录`);

    for (const file of expired) {
      try {
        if (fs.existsSync(file.folder_path)) {
          fs.rmSync(file.folder_path, { recursive: true });
          logger.log(`[清理] 删除过期文件夹: ${file.folder_path}`);
        }
      } catch (err) {
        logger.error(`[清理] 删除文件夹失败: ${file.folder_path}`, err.message);
      }
    }

    // 2. Check file_records: if the stored file was deleted from disk, clean up the DB record
    const allFiles = getAllFiles();
    const allRecords = getAllFileRecords();
    const fileMap = new Map(allFiles.map(f => [f.id, f]));

    let orphanRecords = 0;
    for (const record of allRecords) {
      const fileEntry = fileMap.get(record.file_id);
      if (!fileEntry) continue; // parent record already gone

      const filePath = path.join(fileEntry.folder_path, record.stored_name);
      if (!fs.existsSync(filePath)) {
        deleteFileRecordById(record.id);
        orphanRecords++;
        logger.log(`[清理] 删除孤立文件记录: ${filePath}`);
      }
    }
    if (orphanRecords > 0) {
      logger.log(`[清理] 删除 ${orphanRecords} 条孤立文件记录`);
    }

    // 3. Check files table: if folder doesn't exist, delete DB record; if folder is empty, delete it
    let removedFiles = 0;
    let removedEmptyDirs = 0;
    for (const file of allFiles) {
      const folderExists = fs.existsSync(file.folder_path);
      if (!folderExists) {
        deleteFileById(file.id);
        removedFiles++;
        logger.log(`[清理] 删除不存在文件夹的数据库记录: ${file.folder_path}`);
        continue;
      }

      // Folder exists — check if empty
      try {
        const contents = fs.readdirSync(file.folder_path);
        if (contents.length === 0) {
          fs.rmdirSync(file.folder_path);
          removedEmptyDirs++;
          logger.log(`[清理] 删除空文件夹: ${file.folder_path}`);
          // Also remove the DB record since the folder is gone
          deleteFileById(file.id);
          removedFiles++;
        }
      } catch (err) {
        logger.error(`[清理] 检查文件夹失败: ${file.folder_path}`, err.message);
      }
    }
    if (removedFiles > 0) {
      logger.log(`[清理] 删除 ${removedFiles} 条无效文件记录`);
    }
    if (removedEmptyDirs > 0) {
      logger.log(`[清理] 删除 ${removedEmptyDirs} 个空文件夹`);
    }

    // 4. Remove empty directories in storage root
    const storagePath = getConfig('storagePath');
    if (storagePath) {
      removeEmptyDirs(storagePath);
    }

    logger.log('[清理] 清理任务完成');
  } catch (err) {
    logger.error('[清理] 清理任务出错:', err.message);
  }
}

function startCleanup() {
  // Run immediately on startup
  runCleanup();

  // Schedule periodic cleanup
  setInterval(runCleanup, CLEANUP_INTERVAL);
  logger.log(`[清理] 定时清理已启动，间隔 ${CLEANUP_INTERVAL / 60000} 分钟`);
}

module.exports = { startCleanup, runCleanup };
