const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config');
const { deleteExpiredFiles } = require('../db');

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
          console.log(`[清理] 删除空目录: ${subPath}`);
        }
      } catch {}
    }
  }
}

function runCleanup() {
  try {
    console.log('[清理] 开始执行清理任务...');
    const now = Date.now();

    // Delete expired DB records
    const expired = deleteExpiredFiles(now);
    console.log(`[清理] 删除 ${expired.length} 条过期记录`);

    // Delete expired file folders
    for (const file of expired) {
      try {
        if (fs.existsSync(file.folder_path)) {
          fs.rmSync(file.folder_path, { recursive: true });
          console.log(`[清理] 删除过期文件: ${file.folder_path}`);
        }
      } catch (err) {
        console.error(`[清理] 删除文件失败: ${file.folder_path}`, err.message);
      }
    }

    // Remove empty directories
    const storagePath = getConfig('storagePath');
    if (storagePath) {
      removeEmptyDirs(storagePath);
    }

    console.log('[清理] 清理任务完成');
  } catch (err) {
    console.error('[清理] 清理任务出错:', err.message);
  }
}

function startCleanup() {
  // Run immediately on startup
  runCleanup();

  // Schedule periodic cleanup
  setInterval(runCleanup, CLEANUP_INTERVAL);
  console.log(`[清理] 定时清理已启动，间隔 ${CLEANUP_INTERVAL / 60000} 分钟`);
}

module.exports = { startCleanup, runCleanup };
