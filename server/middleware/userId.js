const { v4: uuidv4 } = require('uuid');

const COOKIE_NAME = 'file_transmit_uid';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year

function userIdMiddleware(req, res, next) {
  let userId = req.cookies[COOKIE_NAME];

  if (!userId) {
    userId = uuidv4();
    res.cookie(COOKIE_NAME, userId, {
      maxAge: COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
    });
  }

  req.userId = userId;
  next();
}

module.exports = userIdMiddleware;
