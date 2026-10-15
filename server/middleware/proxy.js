/**
 * 反向代理中间件。
 *
 * 启用后只把 /api/upload 与 /api/download 的请求原样转发到远程代理服务，
 * 本机不查库、不读文件。/api/admin、/api/access-status 等管理接口始终走本机。
 * 拓扑：
 *   浏览器 -> 本服务(/api) -> 远程代理服务(/api) -> 存储/数据库
 * 因此 baseUrl 填到“/api 的上一层”，转发时自动补 /api + 原始路径。
 *
 * 例：baseUrl=http://host/repository
 *   GET  /api/upload/history  ->  http://host/repository/api/upload/history
 *   POST /api/upload/init     ->  http://host/repository/api/upload/init
 *   GET  /api/admin/stats     ->  本机处理，不转发
 */
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { getConfig, normalizeProxyBaseUrl, isDownloadProxyEnabled } = require('../config');
const logger = require('../utils/logger');

/** 参与代理转发的路径前缀 */
const PROXY_PREFIXES = ['/api/upload', '/api/download'];

function shouldProxy(originalUrl) {
  const pathname = String(originalUrl || '').split('?')[0];
  return PROXY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** 不该被转发的 hop-by-hop 头 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** 客户端 IP：经反向代理时取 X-Forwarded-For / X-Real-IP 里的真实客户端 */
function clientIpOf(req) {
  const { clientIpOf: resolveIp } = require('../utils/clientIp');
  return resolveIp(req);
}

/** 把 Headers 实例或普通对象展开成 [key, value] 列表 */
function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()];
  return Object.entries(headers);
}

function filterReqHeaders(headers) {
  const out = {};
  for (const [k, v] of headerEntries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    // Host / Content-Length 由 fetch 按目标 URL 重算，必须丢弃
    if (key === 'host' || key === 'content-length') continue;
    out[key] = v;
  }
  return out;
}

function filterResHeaders(headers) {
  const out = {};
  for (const [k, v] of headerEntries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function buildForwardedFor(req) {
  const prior = req.headers['x-forwarded-for'];
  const ip = clientIpOf(req);
  return prior ? `${prior}, ${ip}` : ip;
}

/** 字节数转可读大小 */
function formatBytes(n) {
  if (n === null || n === undefined) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return (i === 0 ? String(size) : size.toFixed(1)) + ' ' + units[i];
}

/** 记录一次代理转发的响应结果 */
function logResponse(req, clientIp, target, status, bytes, startedAt) {
  const ms = Date.now() - startedAt;
  const line =
    `[代理] <-- ${status} ${req.method} ${req.originalUrl}` +
    ` 响应=${formatBytes(bytes)} 耗时=${ms}ms IP=${clientIp}`;

  if (status >= 500) logger.error(line);
  else if (status >= 400) logger.warn(line);
  else logger.log(line);
}

function proxyMiddleware() {
  return function proxy(req, res, next) {
    if (!isDownloadProxyEnabled()) return next();
    if (!shouldProxy(req.originalUrl)) return next();

    const base = normalizeProxyBaseUrl(getConfig('downloadProxy')?.baseUrl);
    if (!base) return next();

    // req.originalUrl 含 query string；router 挂载在 /api 下会截掉前缀，所以用 originalUrl
    const target = `${base}${req.originalUrl}`;
    const clientIp = clientIpOf(req);

    const headers = filterReqHeaders(req.headers);
    headers['x-forwarded-for'] = buildForwardedFor(req);
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-forwarded-host'] = req.headers.host || '';

    const init = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    // 带请求体的方法转发原始请求流（分块上传直接透传，不落盘、不解析）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req;
    }

    const startedAt = Date.now();
    const reqSize = Number(req.headers['content-length'] || 0) || null;
    logger.log(
      `[代理] --> ${req.method} ${req.originalUrl} -> ${target}` +
      (reqSize ? ` 请求体=${formatBytes(reqSize)}` : '') +
      ` IP=${clientIp}`
    );

    fetch(target, { ...init, duplex: 'half' })
      .then(async (upstream) => {
        // 状态码与响应头原样回传；不碰 Content-Type / Content-Length，
        // 否则客户端拿到的 JSON 会被当成二进制或按错误长度截断。
        res.status(upstream.status);
        const outHeaders = filterResHeaders(upstream.headers);
        for (const [k, v] of Object.entries(outHeaders)) {
          res.setHeader(k, v);
        }
        // fetch 会把多个 set-cookie 折叠进 entries()，用 getSetCookie 还原
        if (typeof upstream.headers.getSetCookie === 'function') {
          const cookies = upstream.headers.getSetCookie();
          if (cookies && cookies.length) res.setHeader('set-cookie', cookies);
        }

        // 流式回传，避免大文件整体缓冲；字节数用于日志
        let sent = 0;
        if (upstream.body) {
          const src = Readable.fromWeb(upstream.body);
          src.on('data', (c) => { sent += c.length; });
          await pipeline(src, res);
        } else {
          res.end();
        }

        logResponse(req, clientIp, target, upstream.status, sent, startedAt);
      })
      .catch((err) => {
        logger.error(
          `[代理] <-- 失败 ${req.method} ${req.originalUrl} -> ${target}` +
          ` 耗时=${Date.now() - startedAt}ms IP=${clientIp} 原因=${err.message}`
        );
        if (!res.headersSent) {
          res.status(502).json({ error: '代理服务不可用: ' + err.message });
        } else {
          res.destroy();
        }
      });
  };
}

module.exports = proxyMiddleware;
