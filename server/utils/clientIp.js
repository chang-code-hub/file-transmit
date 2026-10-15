/**
 * 客户端真实 IP 解析（支持反向代理 forward 头）
 *
 * 直连时 remoteAddress 就是真实 IP；但经过 nginx / CDN / 负载均衡后，
 * remoteAddress 只是代理节点的 IP，真实客户端 IP 在转发头里。
 * 本项目上传、下载、IP 过滤、日志全部需要真实 IP，所以统一收口到这个模块。
 *
 * 支持的转发头（按优先级）：
 *   1. X-Forwarded-For   —— nginx 通常配 proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for
 *   2. X-Real-IP         —— nginx 通常配 proxy_set_header X-Real-IP $remote_addr
 *   3. Forwarded (RFC 7239) —— 标准头，形如 Forwarded: for=203.0.113.1;proto=https
 *
 * ⚠ 安全前提：这些头是客户端可伪造的。只有当请求确实来自**受信任的反向代理**时，
 * 才能采信它们。因此用 `trustProxy`（config.trustProxy）显式开关：
 *   - false（默认）：只用 socket remoteAddress，转发头一律忽略 —— 防伪造
 *   - true：采信上述转发头 —— 仅在服务端确实在 nginx 之后时开启
 *   - 也可填受信任代理的 IP/CIDR 列表，仅当 remoteAddress 命中时才采信转发头
 *
 * X-Forwarded-For 是逐跳追加的，最左侧是原始客户端，但最左侧同样可被伪造。
 * 有 trustProxy 列表时，从右往左跳过受信任代理，取第一个不受信的地址，
 * 这是唯一无法被伪造的取法。
 */

const { ipMatch } = require('./ipMatch');

/** 把 IPv4-mapped IPv6、端口、方括号等形形色色的写法归一化成裸 IP */
function normalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim();

  // Forwarded 头里的引号和方括号: for="[2001:db8::1]:4711"
  ip = ip.replace(/^"+|"+$/g, '');
  // 去掉端口：IPv4:port 或 [IPv6]:port
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    ip = end > 0 ? ip.slice(1, end) : ip;
  } else {
    // 只在只有一个冒号时按端口剥离，避免破坏 IPv6
    const colons = (ip.match(/:/g) || []).length;
    if (colons === 1) ip = ip.split(':')[0];
  }

  // IPv4-mapped IPv6: ::ffff:192.0.2.1
  ip = ip.replace(/^::ffff:/i, '');
  // 纯 IPv6 的 v4-mapped 另一种写法
  ip = ip.replace(/^::ffff:/i, '');

  // 去掉可能残留的 zone id（fe80::1%eth0）
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);

  return ip;
}

/** 解析 Forwarded (RFC 7239) 头，取第一个 for= 值 */
function parseForwardedHeader(value) {
  if (!value) return '';
  // 可能有多段，用逗号分隔；每段形如 for=1.2.3.4;proto=https;by=...
  const first = String(value).split(',')[0];
  const m = first.match(/for=\s*("?)([^;"]+)\1/i);
  return m ? normalizeIp(m[2]) : '';
}

/** 把 X-Forwarded-For 切成 IP 数组（左→右：原始客户端 → 最近一跳） */
function parseForwardedFor(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
}

/** 判断远端地址是否是受信任的代理 */
function isTrustedProxy(remoteIp, trustProxy) {
  if (trustProxy === true) return true;
  if (!Array.isArray(trustProxy)) return false;
  if (!remoteIp) return false;
  return trustProxy.some(expr => ipMatch(remoteIp, expr));
}

/**
 * 解析真实客户端 IP。
 *
 * @param {object} req - Express request
 * @param {object} [opts]
 * @param {boolean|string[]} [opts.trustProxy] - 受信任代理开关/列表
 * @returns {string} 归一化后的客户端 IP（可能为空字符串）
 */
function getClientIp(req, opts = {}) {
  const remoteIp = normalizeIp(
    req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || ''
  );

  // 未启用信任代理：转发头一律不可信，直接用 socket 地址
  if (!opts.trustProxy) {
    return remoteIp;
  }

  const trusted = isTrustedProxy(remoteIp, opts.trustProxy);

  // 列表模式：remoteAddress 必须命中信任列表才采信转发头
  if (Array.isArray(opts.trustProxy) && !trusted) {
    return remoteIp;
  }

  // X-Forwarded-For：从右往左跳过受信任代理，取第一个不受信地址
  const chain = parseForwardedFor(req.headers['x-forwarded-for']);
  if (chain.length > 0) {
    if (trusted && Array.isArray(opts.trustProxy)) {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(chain[i], opts.trustProxy)) return chain[i];
      }
      return chain[chain.length - 1];
    }
    // trustProxy === true：无信任列表可比对，按惯例取最左侧（原始客户端）
    return chain[0];
  }

  // X-Real-IP
  const realIp = normalizeIp(req.headers['x-real-ip']);
  if (realIp) return realIp;

  // Forwarded (RFC 7239)
  const fwd = parseForwardedHeader(req.headers['forwarded']);
  if (fwd) return fwd;

  return remoteIp;
}

/**
 * 便捷封装：从当前配置读取 trustProxy 并解析。
 * 各路由统一用它，避免每个文件重复写 req.ip 兜底逻辑。
 */
function clientIpOf(req) {
  let trustProxy = false;
  try {
    const { getConfig } = require('../config');
    trustProxy = getConfig('trustProxy');
  } catch {
    trustProxy = false;
  }
  return getClientIp(req, { trustProxy });
}

module.exports = {
  getClientIp,
  clientIpOf,
  normalizeIp,
  parseForwardedFor,
  parseForwardedHeader,
  isTrustedProxy,
};
