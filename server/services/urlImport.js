/**
 * 从互联网 URL 导入文件。
 *
 * 两条能力：
 *  - resolveRemoteFile(url)   探测远端，解析出文件名 / 大小 / MIME（只读响应头，不下载正文）
 *  - downloadToFile(url, dest) 把远端文件流式写到本地（「托管」模式）
 *
 * 文件名解析顺序（与前端约定一致）：
 *  1. URL 路径最后一段本身就像文件名（带扩展名） -> 直接用
 *  2. 否则取响应头 Content-Disposition（filename* 优先于 filename）
 *  3. 都没有 -> 用路径最后一段作词干，按 Content-Type 补扩展名
 *  4. 再不行 -> download<扩展名>
 *
 * 安全边界：
 *  - 只放行 http/https（挡住 file:、ftp: 等本地/其它协议）
 *  - 跟随重定向，但最终仍是 http(s)
 *  - 探测 15s 超时；下载整体 30 分钟超时 + 60s 无数据即中断
 *  - 注意：这是**服务端代取**，等价于 SSRF 面。内网可达性由部署方自行约束
 *    （IP 过滤只管本服务的访问方，不管本服务去访问谁）。
 */
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const logger = require('../utils/logger');

const PROBE_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 1000;
const USER_AGENT = 'file-transmit/1.0';

/** Content-Type -> 扩展名（没有命中的走通用规则） */
const MIME_EXT = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-7z-compressed': '.7z',
  'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-tar': '.tar',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/css': '.css',
  'text/markdown': '.md',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/x-matroska': '.mkv',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
};

/**
 * 校验并归一化用户提交的链接。非法一律抛中文错误信息。
 * @param {string} raw
 * @returns {URL}
 */
function normalizeSourceUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('请输入链接地址');
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error('链接格式无效，需形如 https://example.com/file.zip');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// 开头的链接');
  }
  if (!u.hostname) throw new Error('链接缺少主机名');
  return u;
}

/**
 * 文件名安全化：去掉路径分隔符与控制字符、前导点，限制长度。
 * 落盘路径由它把关，避免 ../ 之类的路径穿越。
 */
function sanitizeFileName(name) {
  let n = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!n) return '';
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, Math.max(1, 180 - ext.length)) + ext;
  }
  return n;
}

/** 解析 Content-Disposition：filename* (RFC 5987) 优先，其次 filename */
function parseContentDisposition(value) {
  const raw = String(value || '');
  if (!raw) return '';

  const star = /filename\*\s*=\s*([^;]+)/i.exec(raw);
  if (star) {
    let v = star[1].trim().replace(/^"|"$/g, '');
    const m = /^[^']*'[^']*'(.*)$/.exec(v);
    if (m) v = m[1];
    try {
      const decoded = decodeURIComponent(v);
      if (decoded) return decoded;
    } catch { /* 编码不合法就继续往下试 filename= */ }
  }

  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(raw);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');

  const bare = /filename\s*=\s*([^;]+)/i.exec(raw);
  if (bare) {
    const v = bare[1].trim().replace(/^"|"$/g, '');
    if (v) return v;
  }
  return '';
}

/** 看起来像文件名：末尾有 .扩展名 */
function looksLikeFileName(name) {
  return /\.[A-Za-z0-9]{1,15}$/.test(String(name || ''));
}

/** Content-Type -> 扩展名（拿不准就返回空串） */
function extFromMime(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!type) return '';
  if (MIME_EXT[type]) return MIME_EXT[type];
  if (type === 'application/octet-stream') return '';
  const m = /^(image|video|audio)\/([a-z0-9]+)$/.exec(type);
  if (m) return '.' + m[2];
  return '';
}

/** URL 路径最后一段（已解码、已安全化），取不到返回空串 */
function pathSegmentOf(u) {
  const url = typeof u === 'string' ? new URL(u) : u;
  const raw = url.pathname.split('/').filter(Boolean).pop() || '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch { /* 编码坏了就用原样 */ }
  return sanitizeFileName(decoded);
}

/**
 * 按约定顺序挑出文件名。
 * @param {string} finalUrl 实际取到响应的那个 URL（跟随重定向后）
 * @param {Headers} headers
 */
function pickFileName(finalUrl, headers) {
  const seg = pathSegmentOf(finalUrl);
  const headerName = sanitizeFileName(parseContentDisposition(headers.get('content-disposition')));
  const mimeExt = extFromMime(headers.get('content-type'));

  if (seg && looksLikeFileName(seg)) return seg;
  if (headerName) {
    if (looksLikeFileName(headerName) || !mimeExt) return headerName;
    return headerName + mimeExt;
  }
  if (seg) return mimeExt && !looksLikeFileName(seg) ? seg + mimeExt : seg;
  return 'download' + mimeExt;
}

/** 从响应头取总字节数（Range 响应用 content-range 的总数，别把 1 字节当总长） */
function sizeFromHeaders(headers) {
  const range = headers.get('content-range');
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) return Number(m[1]);
  }
  const len = headers.get('content-length');
  if (len && /^\d+$/.test(len)) return Number(len);
  return 0;
}

/** 只取消响应体（探测时不要正文） */
async function drainBody(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') await res.body.cancel();
  } catch { /* 已经关了就不管 */ }
}

/**
 * 探测远端链接，解析出文件名 / 大小 / MIME。不下载正文。
 *
 * 先 HEAD；HEAD 被拒、或「路径里没有文件名且响应头也没给 Content-Disposition」时，
 * 改用 `Range: bytes=0-0` 的 GET —— 拿到响应头就立刻掐掉正文。
 *
 * @param {string} rawUrl
 * @returns {Promise<{sourceUrl:string, finalUrl:string, fileName:string, size:number, mimeType:string, extensionAllowed:boolean}>}
 */
async function resolveRemoteFile(rawUrl) {
  const target = normalizeSourceUrl(rawUrl);
  let headers = null;
  let finalUrl = target.toString();

  try {
    const res = await fetch(target, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });
    if (res.ok) {
      headers = res.headers;
      finalUrl = res.url || finalUrl;
    }
    await drainBody(res);
  } catch (err) {
    logger.log(`[链接导入] HEAD 探测失败: ${target.host} ${err.message}，改用 Range GET`);
  }

  const seg = pathSegmentOf(finalUrl);
  const needDisposition = !(seg && looksLikeFileName(seg));
  const hasDisposition = !!(headers && headers.get('content-disposition'));

  if (!headers || (needDisposition && !hasDisposition)) {
    try {
      const res = await fetch(target, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, accept: '*/*', range: 'bytes=0-0' },
      });
      if (!res.ok && res.status !== 206) {
        await drainBody(res);
        throw new Error(`远程服务器返回 ${res.status}`);
      }
      headers = res.headers;
      finalUrl = res.url || finalUrl;
      await drainBody(res);
    } catch (err) {
      throw new Error(`无法读取该链接：${err.message}`);
    }
  }

  const mimeType = String(headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const fileName = pickFileName(finalUrl, headers);

  return {
    sourceUrl: String(rawUrl).trim(),
    finalUrl,
    fileName,
    size: sizeFromHeaders(headers),
    mimeType,
  };
}

/**
 * 把远端文件流式下载到 destPath。
 *
 * @param {string} rawUrl
 * @param {string} destPath 目标路径（父目录需已存在）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 整体超时，默认 30 分钟
 * @returns {Promise<{size:number, mimeType:string, finalUrl:string}>}
 */
async function downloadToFile(rawUrl, destPath, opts = {}) {
  const target = normalizeSourceUrl(rawUrl);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DOWNLOAD_TIMEOUT_MS;

  const res = await fetch(target, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
  });
  if (!res.ok) {
    await drainBody(res);
    throw new Error(`远程服务器返回 ${res.status}`);
  }
  if (!res.body) throw new Error('远程服务器没有返回文件内容');

  const src = Readable.fromWeb(res.body);
  const ws = fs.createWriteStream(destPath);
  let size = 0;
  let idleTimer = null;

  const stopIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdle = () => {
    stopIdle();
    idleTimer = setTimeout(() => {
      src.destroy(new Error(`超过 ${IDLE_TIMEOUT_MS / 1000} 秒没有收到数据`));
    }, IDLE_TIMEOUT_MS);
  };

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      armIdle();
      cb(null, chunk);
    },
  });

  armIdle();
  try {
    await pipeline(src, counter, ws);
  } catch (err) {
    stopIdle();
    try { fs.rmSync(destPath, { force: true }); } catch { /* 半截文件尽力清理 */ }
    throw new Error(`下载中断：${err.message}`);
  }
  stopIdle();

  return {
    size,
    mimeType: String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    finalUrl: res.url || target.toString(),
  };
}

module.exports = {
  normalizeSourceUrl,
  sanitizeFileName,
  resolveRemoteFile,
  downloadToFile,
  PROBE_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
};
