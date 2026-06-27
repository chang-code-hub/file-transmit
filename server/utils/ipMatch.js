const net = require('net');

/**
 * Check if an IP matches an expression.
 * Supports:
 *   - CIDR: 192.168.1.0/24
 *   - Range: 192.168.1.1-192.168.1.100
 *   - Single IP: 192.168.1.1
 */
function ipMatch(ip, expression) {
  if (!ip || !expression) return false;
  const expr = expression.trim();

  // CIDR notation
  if (expr.includes('/')) {
    return matchCIDR(ip, expr);
  }

  // Range notation
  if (expr.includes('-')) {
    return matchRange(ip, expr);
  }

  // Single IP
  return ip === expr;
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return -1;
  return ((+parts[0] << 24) >>> 0) +
         ((+parts[1] << 16) >>> 0) +
         ((+parts[2] << 8) >>> 0) +
         (+parts[3] >>> 0);
}

function matchCIDR(ip, cidr) {
  try {
    const [subnet, bits] = cidr.split('/');
    const maskBits = parseInt(bits, 10);
    if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) return false;

    const ipInt = ipToInt(ip);
    const subnetInt = ipToInt(subnet);
    if (ipInt === -1 || subnetInt === -1) return false;

    const mask = ~(2 ** (32 - maskBits) - 1) >>> 0;
    return (ipInt & mask) === (subnetInt & mask);
  } catch {
    return false;
  }
}

function matchRange(ip, range) {
  try {
    const [start, end] = range.split('-').map(s => s.trim());
    const ipInt = ipToInt(ip);
    const startInt = ipToInt(start);
    const endInt = ipToInt(end);
    if (ipInt === -1 || startInt === -1 || endInt === -1) return false;
    return ipInt >= startInt && ipInt <= endInt;
  } catch {
    return false;
  }
}

module.exports = { ipMatch };
