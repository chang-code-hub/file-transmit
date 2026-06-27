const { getConfig } = require('../config');

/**
 * Admin authentication middleware.
 * Requires x-admin-password header to match the configured admin password.
 */
function adminAuth(req, res, next) {
  const password = req.headers['x-admin-password'];
  const configPassword = getConfig('adminPassword');

  if (!password || password !== configPassword) {
    return res.status(401).json({ error: '管理员密码错误' });
  }

  next();
}

module.exports = adminAuth;
