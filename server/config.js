const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let config = {};

function getDefaultStoragePath() {
  if (os.platform() === 'win32') {
    // Try D: drive first, then C:, then E:, etc.
    const drives = ['D:', 'E:', 'F:', 'G:', 'C:'];
    for (const drive of drives) {
      if (fs.existsSync(drive + '\\')) {
        return path.join(drive, 'FileTransmit', 'file');
      }
    }
  }
  return '/var/usr/FileTransmit/file';
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } else {
    config = {};
  }

  // Set defaults
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
  if (config.enableAntivirusScan === undefined) config.enableAntivirusScan = false;
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

function updateConfig(updates) {
  // Don't overwrite adminPassword with empty
  if (updates.adminPassword === '' || updates.adminPassword === undefined) {
    delete updates.adminPassword;
  }
  Object.assign(config, updates);
  saveConfig();
  return config;
}

module.exports = { loadConfig, saveConfig, getConfig, updateConfig };
