const { getConfig } = require('../config');
const { ipMatch } = require('../utils/ipMatch');

/**
 * Check whether a given IP is allowed for a given mode.
 * @param {'upload'|'download'} mode - which filter config to use
 * @param {string} clientIp - the IP address to check
 * @returns {boolean} true if access is allowed, false if blocked
 */
function checkIpAccess(mode, clientIp) {
  const ipConfig = getConfig('ipFilter');
  if (!ipConfig) return true;

  const filter = ipConfig[mode];
  if (!filter || !filter.enabled || !filter.list || filter.list.length === 0) {
    return true;
  }

  // Normalize IPv4-mapped IPv6
  const ip = clientIp.replace(/^::ffff:/, '');

  const matched = filter.list.some(expr => ipMatch(ip, expr));

  if (filter.mode === 'allow') {
    // Allowlist: only matched IPs can access
    return matched;
  } else {
    // Blocklist: matched IPs are blocked
    return !matched;
  }
}

/**
 * IP filter middleware factory.
 * @param {'upload'|'download'} mode - which filter config to use
 */
function ipFilter(mode) {
  return function (req, res, next) {
    const clientIp = req.ip || req.connection.remoteAddress || '127.0.0.1';

    if (!checkIpAccess(mode, clientIp)) {
      const ipConfig = getConfig('ipFilter');
      const filter = ipConfig[mode];
      if (filter && filter.mode === 'allow') {
        return res.status(403).json({ error: 'IP 不在允许访问的列表中' });
      } else {
        return res.status(403).json({ error: 'IP 已被禁止访问' });
      }
    }

    next();
  };
}

module.exports = ipFilter;
module.exports.checkIpAccess = checkIpAccess;
