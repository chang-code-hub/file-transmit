const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./utils/logger');

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
  // 上传/下载代理分开配置，允许只配其中一个。
  // 旧版本只有一个 downloadProxy（同时管上传+下载），首次启动时迁移成两份，
  // 并按 enabled 为空 / baseUrl 为空的组合补全缺失的那一份。
  if (!config.downloadProxy || typeof config.downloadProxy !== 'object') {
    config.downloadProxy = {};
  }
  const legacyProxy = config.downloadProxy;
  if (legacyProxy.enabled === undefined) legacyProxy.enabled = false;
  if (!legacyProxy.baseUrl) legacyProxy.baseUrl = '';

  if (!config.uploadProxy || typeof config.uploadProxy !== 'object') {
    config.uploadProxy = {
      enabled: legacyProxy.enabled && !!legacyProxy.baseUrl,
      baseUrl: legacyProxy.baseUrl,
    };
  }
  if (config.uploadProxy.enabled === undefined) config.uploadProxy.enabled = false;
  if (!config.uploadProxy.baseUrl) config.uploadProxy.baseUrl = '';
  // 「下载优先本地」：开着下载代理时，先看本机磁盘有没有这个文件，
  // 有就直接本机出（省一次远程往返），没有才转发上游。默认关，保持原有行为。
  if (config.preferLocalDownload === undefined) config.preferLocalDownload = false;
  if (!config.ipFilter) {
    config.ipFilter = {
      upload: { enabled: false, mode: 'allow', list: [] },
      download: { enabled: false, mode: 'allow', list: [] },
    };
  }
  // 上传完成后的 webhook：支持多个（webhooks 数组），各自独立启停与签名。
  // webhookPublicUrl / webhookTimeoutMs 是所有 webhook 共用的全局项。
  if (!config.webhooks || !Array.isArray(config.webhooks)) config.webhooks = [];
  // 旧的单个 webhook 对象 -> 迁成数组里的一项（只迁一次）
  if (config.webhook && typeof config.webhook === 'object' && Object.keys(config.webhook).length) {
    const legacy = config.webhook;
    if (config.webhooks.length === 0 && (legacy.url || legacy.enabled)) {
      config.webhooks.push({
        name: '默认',
        enabled: !!legacy.enabled,
        url: String(legacy.url || '').trim(),
        secret: String(legacy.secret || ''),
      });
    }
    delete config.webhook;
  }
  if (!config.webhookPublicUrl) config.webhookPublicUrl = '';
  if (!config.webhookTimeoutMs || typeof config.webhookTimeoutMs !== 'number') {
    config.webhookTimeoutMs = 10000;
  }
  for (const wh of config.webhooks) {
    if (!wh.name) wh.name = '';
    if (wh.enabled === undefined) wh.enabled = false;
    if (!wh.url) wh.url = '';
    if (!wh.secret) wh.secret = '';
  }

  // 下载令牌：Jenkins / 邮件脚本等服务端调用方用它访问 /api/download/*。
  // 与管理员口令分开，权限最小化（只能读已发布的文件，改不了设置）。
  if (config.downloadToken === undefined) config.downloadToken = '';
  // 首次自动生成管理员口令的标记；管理员手动改过口令后会被清掉
  if (config.adminPasswordIsGenerated === undefined) {
    config.adminPasswordIsGenerated = config.adminPassword === 'admin123';
  }


  // 确保存储目录存在。storagePath 可能在管理页被改成相对/绝对路径，
  // 若解析失败（例如盘符不存在、权限不足）回退到默认目录 —— 否则启动直接崩，
  // 而且会把错误路径固化进 config.json，连管理页都进不去。
  const resolvedStorage = (() => {
    try {
      fs.mkdirSync(config.storagePath, { recursive: true });
      return path.resolve(config.storagePath);
    } catch (err) {
      logger.error(
        `存储路径不可用: ${config.storagePath} (${err.message})，` +
        `回退到默认目录 ${path.resolve(getDefaultStoragePath())}`
      );
      const fallback = getDefaultStoragePath();
      try { fs.mkdirSync(fallback, { recursive: true }); } catch (e2) {
        logger.error(`默认目录也创建失败: ${e2.message}`);
      }
      return path.resolve(fallback);
    }
  })();
  if (resolvedStorage !== path.resolve(config.storagePath)) {
    config.storagePath = resolvedStorage;
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

/** 某一类 IP 过滤是否处于启用状态（开关打开且列表非空） */
function checkIpAccessEnabled(cfg, mode) {
  const filter = (cfg.ipFilter || {})[mode];
  return !!(filter && filter.enabled && Array.isArray(filter.list) && filter.list.length > 0);
}

/**
 * IP 过滤是否生效（上传或下载任一启用即为 true）。
 * 每次访问现算，所以管理页保存后立刻反映，也不需要写进 config.json。
 * 该值只读，供 /api/access-status 给前端显隐「IP 过滤」入口。
 */
function isIpFilterActive() {
  return checkIpAccessEnabled(config, 'upload') || checkIpAccessEnabled(config, 'download');
}

/**
 * 校验并归一化单个 webhook（管理端保存与启动自检共用）。
 * @param {object} raw
 * @param {object} [opts] { requireUrl: 启用时地址是否必填，默认 true }
 * @returns {{ok:boolean, value?:object, error?:string}}
 */
function validateWebhook(raw, opts = {}) {
  const requireUrl = opts.requireUrl !== false;
  const item = raw || {};
  const url = String(item.url || '').trim();
  const enabled = !!item.enabled;
  if (enabled && requireUrl && !url) return { ok: false, error: 'Webhook 地址不能为空' };
  if (url) {
    let u;
    try { u = new URL(url); } catch { u = null; }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      return { ok: false, error: `Webhook 地址无效（${url}），需为 http(s):// 开头的合法 URL` };
    }
  }
  return {
    ok: true,
    value: {
      name: String(item.name || '').trim().slice(0, 40),
      enabled,
      url,
      secret: String(item.secret || ''),
    },
  };
}

/**
 * Normalize a proxy base URL（上传/下载共用）。
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

/**
 * 某一路代理是否真正启用（开关打开且地址合法）。
 * @param {'upload'|'download'} kind
 */
function isProxyEnabled(kind) {
  const proxy = kind === 'upload' ? config.uploadProxy : config.downloadProxy;
  return !!(proxy && proxy.enabled && normalizeProxyBaseUrl(proxy.baseUrl));
}

/** 上传代理是否启用 */
function isUploadProxyEnabled() {
  return isProxyEnabled('upload');
}

/** 下载代理是否启用（保持旧名，供既有调用方使用） */
function isDownloadProxyEnabled() {
  return isProxyEnabled('download');
}

/** 任一代理启用时为 true */
function isAnyProxyEnabled() {
  return isUploadProxyEnabled() || isDownloadProxyEnabled();
}

/**
 * 代理中间件用：按请求路径前缀挑出该走哪一路代理。
 * 未命中返回 null，调用方直接 next() 走本机实现。
 *
 * @param {string} originalUrl 含 query 的原始 URL
 * @returns {{kind:'upload'|'download', base:string}|null}
 */
function resolveProxyFor(originalUrl) {
  const pathname = String(originalUrl || '').split('?')[0];
  const matched = pathname === '/api/upload' || pathname.startsWith('/api/upload/')
    ? 'upload'
    : (pathname === '/api/download' || pathname.startsWith('/api/download/'))
      ? 'download'
      : null;
  if (!matched) return null;
  if (!isProxyEnabled(matched)) return null;

  const proxy = matched === 'upload' ? config.uploadProxy : config.downloadProxy;
  const base = normalizeProxyBaseUrl(proxy.baseUrl);
  return base ? { kind: matched, base } : null;
}


/**
 * 「下载优先本地」是否开启。
 * @returns {boolean}
 */
function isPreferLocalDownload() {
  return !!config.preferLocalDownload;
}

/**
 * 本机是否存有该 fileId 的实际文件（有文件夹且里面至少有一个文件）。
 * 供「下载优先本地」判断：有就本机出，没有才走上游代理。
 *
 * 只看文件系统、不查库 —— 代理中间件挂载在 body 解析器之前，
 * 那时 DB 还没初始化，查库会抛 "Database not initialized"。
 *
 * @param {string} fileId
 * @returns {boolean}
 */
function hasLocalFile(fileId) {
  const id = String(fileId || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(id)) return false;
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(config.storagePath || 'files', id);
    if (!fs.existsSync(dir)) return false;
    // 只认真实文件；.chunks（上传中的分块暂存）不算，避免半截上传被当成成品下载
    const names = fs.readdirSync(dir);
    return names.some((n) => n !== '.chunks' && fs.statSync(path.join(dir, n)).isFile());
  } catch {
    return false;
  }
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
  isProxyEnabled,
  isUploadProxyEnabled,
  isDownloadProxyEnabled,
  isAnyProxyEnabled,
  resolveProxyFor,
  isIpFilterActive,
  validateWebhook,
  isPreferLocalDownload,
  hasLocalFile,
};
