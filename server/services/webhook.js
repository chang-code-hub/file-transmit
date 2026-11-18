/**
 * 上传完成 webhook。
 *
 * 上传成功（/api/upload/complete 写库之后）异步 POST 一份 JSON 到所有已启用的 URL
 * （config.webhooks 数组，可配多个），
 * 内容包含文件 ID、附件清单和每个附件的下载链接。
 *
 * 设计要点：
 * - **绝不阻塞上传响应**：调用方 fire-and-forget，本模块内部 catch 所有异常。
 * - **超时**：用 AbortSignal.timeout，webhook 端卡死也不会拖住进程。
 * - **签名**：配置了 secret 时带 X-Webhook-Signature: sha256=<hmac>，
 *   对应 HMAC-SHA256(secret, 原始 JSON 字符串)，接收方可校验来源与防篡改。
 * - **代理无关**：下载链接用页面自身能访问到的地址（publicUrl 或请求的 Host），
 *   不取决于上传/下载有没有开代理。
 */
const crypto = require('crypto');
const { getConfig } = require('../config');
const logger = require('../utils/logger');

/**
 * 归一化对外可访问的站点根地址（不带末尾斜杠）。
 * 优先级：配置的 publicUrl > 本次请求的 Host（经反代时配合 trustProxy 取转发头）。
 *
 * @param {object} [req] express 请求，可无
 * @returns {string} 形如 http://192.168.1.10:3000，拿不到时返回空串
 */
function resolvePublicOrigin(req) {
  const configured = String(
    getConfig('webhookPublicUrl') ?? getConfig('webhook')?.publicUrl ?? ''
  ).trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (!req || !req.headers) return '';

  const proto = (req.protocol || 'http').replace(/[^a-z]/gi, '') || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return host ? `${proto}://${host}` : '';
}

/** 单个附件的直链（与前端点文件名下载走同一个接口） */
function buildFileDownloadUrl(origin, fileId, storedName) {
  const base = String(origin || '').replace(/\/+$/, '');
  return `${base}/api/download/${encodeURIComponent(fileId)}/${encodeURIComponent(storedName)}`;
}

/** 全量打包下载链接 */
function buildZipDownloadUrl(origin, fileId) {
  const base = String(origin || '').replace(/\/+$/, '');
  return `${base}/api/download/${encodeURIComponent(fileId)}/zip`;
}

/** 前端分享页（HashRouter），接收方点开即可看到文件列表 */
function buildShareUrl(origin, fileId) {
  const base = String(origin || '').replace(/\/+$/, '');
  return `${base}/#/down?f=${encodeURIComponent(fileId)}`;
}

/** 按保留时长算出的过期时间（毫秒时间戳） */
function resolveExpiresAt(config, createdAt) {
  const hours = Number(config.retentionHours);
  const ms = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return createdAt + ms * 60 * 60 * 1000;
}

/** 字节数 -> 可读大小 */
function formatBytes(n) {
  const size = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = size;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

/**
 * 组装 webhook 负载。
 *
 * @param {object} p
 * @param {object} p.file            数据库行（id/description/created_at/expires_at/uploader_ip）
 * @param {Array}  p.records         file_records 行（original_name/stored_name/size/mime_type）
 * @param {Array}  p.succeededFiles  本次实际上传成功的文件 [{name, size}]
 * @param {Array}  p.failedFiles     本次被跳过的文件
 * @param {string} p.origin          站点根地址
 * @param {object} p.config          当前配置
 * @param {object} [p.req]           用于补全无 publicUrl 时的 Host
 */
function buildPayload({ file, records, succeededFiles = [], failedFiles = [], origin, config, req }) {
  const createdAt = Number(file.created_at) || Date.now();
  const expiresAt = Number(file.expires_at) || resolveExpiresAt(config, createdAt);

  const attachments = (records || []).map((r) => ({
    fileName: r.original_name,
    storedName: r.stored_name,
    size: Number(r.size) || 0,
    sizeText: formatBytes(r.size),
    mimeType: r.mime_type || '',
    downloadUrl: buildFileDownloadUrl(origin, file.id, r.stored_name),
  }));

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);

  return {
    event: 'upload.completed',
    fileId: file.id,
    description: file.description || '',
    createdAt,
    createdAtText: new Date(createdAt).toISOString(),
    expiresAt,
    expiresAtText: new Date(expiresAt).toISOString(),
    retentionHours: Number(config.retentionHours) || 24,
    uploaderIp: file.uploader_ip || '',
    userAgent: file.uploader_ua || '',
    origin,
    shareUrl: buildShareUrl(origin, file.id),
    zipUrl: buildZipDownloadUrl(origin, file.id),
    fileCount: attachments.length,
    totalSize,
    totalSizeText: formatBytes(totalSize),
    attachments,
    succeededFiles: succeededFiles.map((f) => ({ name: f.name, size: Number(f.size) || 0 })),
    failedFiles: (failedFiles || []).map((f) => (typeof f === 'string' ? { name: f } : f)),
    _req: req, // 仅供 sendWebhook 前补 Host，不进 JSON
  };
}

/** HMAC-SHA256 签名，头部值形如 sha256=<hex> */
function sign(secret, rawBody) {
  if (!secret) return null;
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(rawBody, 'utf8').digest('hex');
}

/**
 * 向**一个** webhook 发送负载。异常都在内部吞掉并记日志，调用方可安全地不 await。
 *
 * @param {object} payload buildPayload 的返回值（不含 _req）
 * @param {object} target  { name?, url, secret?, enabled? }
 * @param {object} [opts]  { timeoutMs }
 * @returns {Promise<object>} {ok, status?, error?, ms} 或 {skipped:true}
 */
async function sendWebhook(payload, endpoint, opts = {}) {
  const startedAt = Date.now();
  const webhook = endpoint || {};
  const url = String(webhook.url || '').trim();
  const label = webhook.name ? `[Webhook:${webhook.name}]` : '[Webhook]';
  if (webhook.enabled === false || !url) return { ok: false, skipped: true, ms: 0 };

  let target;
  try {
    target = new URL(url);
  } catch {
    logger.error(label + ' 地址无效，未发送: ' + url);
    return { ok: false, error: 'invalid_url', ms: 0 };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    logger.error(label + ' 仅支持 http(s) 地址: ' + url);
    return { ok: false, error: 'unsupported_protocol', ms: 0 };
  }

  // 负载里不带内部字段 _req
  const { _req, ...body } = payload;
  const globalTimeout = Number(getConfig('webhookTimeoutMs'));
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs)
    : (Number.isFinite(globalTimeout) && globalTimeout > 0 ? globalTimeout : 10000);
  const rawBody = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'file-transmit-webhook/1.0',
    'x-webhook-event': body.event || 'upload.completed',
    'x-webhook-delivery': crypto.randomUUID(),
  };
  const signature = sign(webhook.secret, rawBody);
  if (signature) headers['x-webhook-signature'] = signature;

  try {
    const res = await fetch(target, {
      method: 'POST',
      headers,
      body: rawBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - startedAt;
    let detail = '';
    if (!res.ok) {
      try { detail = (await res.text()).slice(0, 300); } catch {}
    }
    const line =
      `${label} --> POST ${target.origin}${target.pathname} ` +
      `fileId=${body.fileId} 附件=${(body.attachments || []).length} ` +
      `<-- ${res.status} 耗时=${ms}ms${detail ? ' body=' + detail : ''}`;
    if (res.ok) logger.log(line); else logger.error(line);
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    const ms = Date.now() - startedAt;
    const reason = err?.name === 'TimeoutError' ? `超时 (${timeoutMs}ms)` : (err?.message || '未知错误');
    logger.error(
      `${label} <-- 失败 POST ${target.origin}${target.pathname} ` +
      `fileId=${body.fileId} 耗时=${ms}ms 原因=${reason}`
    );
    return { ok: false, error: reason, ms };
  }
}

/**
 * 向**所有**已启用的 webhook 并发发送（单个失败不影响其它，也不影响调用方）。
 *
 * @param {object} payload buildPayload 的返回值
 * @returns {Promise<Array<{name,url,ok,status?,error?,ms}>>}
 */
async function sendWebhooks(payload) {
  const list = (getConfig('webhooks') || []).filter((w) => w && w.enabled && String(w.url || '').trim());
  if (list.length === 0) return [];
  const results = await Promise.all(list.map(async (w) => {
    const r = await sendWebhook(payload, w);
    return { name: w.name || '', url: w.url, ...r };
  }));
  const okCount = results.filter((r) => r.ok).length;
  logger.log(`[Webhook] 本次共 ${list.length} 个启用，成功 ${okCount} 个` +
    (okCount === list.length ? '' : `（失败 ${list.length - okCount} 个）`));
  return results;
}

module.exports = {
  resolvePublicOrigin,
  buildFileDownloadUrl,
  buildZipDownloadUrl,
  buildShareUrl,
  resolveExpiresAt,
  formatBytes,
  buildPayload,
  sign,
  sendWebhook,
  sendWebhooks,
};
