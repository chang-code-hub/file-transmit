const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let config = {};

function getDefaultStoragePath() { 
  return 'files';
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } else {
    config = {};
  }

  // Set defaults
  if (!config.port) config.port = 3000;
  if (!config.storagePath || config.storagePath === '') {
    config.storagePath = getDefaultStoragePath();
  }
  if (!config.retentionHours) config.retentionHours = 24;
  if (!config.adminPassword) config.adminPassword = 'admin123';
  if (!config.allowedFileTypes) {
    config.allowedFileTypes = {
      documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv'],
      images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp'],
      archives: ['.zip', '.rar', '.7z', '.tar', '.gz'],
      videos: ['.mp4', '.avi', '.mkv', '.mov', '.wmv'],
      audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg'],
      code: ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.html', '.css', '.json', '.xml'],
      custom: [],
    };
  }
  if (config.blockEncryptedArchives === undefined) config.blockEncryptedArchives = true;
  if (config.detectArchiveByContent === undefined) config.detectArchiveByContent = false;
  if (config.recursiveArchiveCheck === undefined) config.recursiveArchiveCheck = false;
  if (config.sevenZipPath === undefined) config.sevenZipPath = '';
  if (config.unrarPath === undefined) config.unrarPath = '';
  // 反向代理信任：false=忽略转发头（默认，防伪造）；true=采信转发头；
  // 数组=仅当 remoteAddress 命中列表时才采信，形如 ["127.0.0.1", "10.0.0.0/8"]
  if (config.trustProxy === undefined) config.trustProxy = false;
  if (config.enableVirusDetect === undefined) config.enableVirusDetect = false;
  if (config.clamscanPath === undefined) config.clamscanPath = '';
  if (!config.downloadProxy || typeof config.downloadProxy !== 'object') {
    config.downloadProxy = {};
  }
  if (config.downloadProxy.enabled === undefined) config.downloadProxy.enabled = false;
  if (!config.downloadProxy.baseUrl) config.downloadProxy.baseUrl = '';
  if (!config.ipFilter) {
    config.ipFilter = {
      upload: { enabled: false, mode: 'allow', list: [] },
      download: { enabled: false, mode: 'allow', list: [] },
    };
  }

  // Ensure storage directory exists
  if (!fs.existsSync(config.storagePath)) {
    fs.mkdirSync(config.storagePath, { recursive: true });
  }

  saveConfig();
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function getConfig(key) {
  if (key) return config[key];
  return config;
}

/**
 * Normalize a download-proxy base URL.
 * - trims whitespace
 * - returns '' when empty or invalid
 * - keeps scheme + host + pathname, drops query/hash
 * - ensures exactly one '/' between path and the appended fileId/fileName
 */
function normalizeProxyBaseUrl(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  // Drop query/hash — only the path prefix matters for prefixing downloads
  url.search = '';
  url.hash = '';

  // Collapse trailing slashes so callers can safely append '/id/name'
  const base = url.toString().replace(/\/+$/, '');
  return base;
}

/** Is the download proxy currently active? */
function isDownloadProxyEnabled() {
  return !!(config.downloadProxy && config.downloadProxy.enabled
    && normalizeProxyBaseUrl(config.downloadProxy.baseUrl));
}

function updateConfig(updates) {
  // Don't overwrite adminPassword with empty
  if (updates.adminPassword === '' || updates.adminPassword === undefined) {
    delete updates.adminPassword;
  }
  Object.assign(config, updates);
  saveConfig();
  return config;
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfig,
  updateConfig,
  normalizeProxyBaseUrl,
  isDownloadProxyEnabled,
};
