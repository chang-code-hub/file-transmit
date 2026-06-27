/**
 * Timestamped logger with date-stamped file output.
 * Writes to both console (for nssm capture / dev mode) and
 * daily-rotated log files under logs/ directory.
 * Auto-cleans log files older than 30 days.
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_RETENTION_DAYS = 30;

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// --- File stream management (auto-rotate on date change) ---
let _currentDate = '';
let _logStream = null;

function getDateStr() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getLogStream() {
  const today = getDateStr();
  if (today !== _currentDate) {
    if (_logStream) {
      _logStream.end();
    }
    const filePath = path.join(LOG_DIR, `app-${today}.log`);
    _logStream = fs.createWriteStream(filePath, { flags: 'a' });
    _currentDate = today;
  }
  return _logStream;
}

// --- Timestamp ---
function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// --- Log file cleanup ---
function cleanupOldLogs(days = LOG_RETENTION_DAYS) {
  try {
    if (!fs.existsSync(LOG_DIR)) return;

    const now = Date.now();
    const maxAge = days * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOG_DIR);
    let deleted = 0;

    for (const file of files) {
      // Match app-YYYY-MM-DD.log pattern
      const match = file.match(/^app-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match) continue;

      const fileDate = new Date(match[1] + 'T00:00:00');
      if (isNaN(fileDate.getTime())) continue;

      if (now - fileDate.getTime() > maxAge) {
        const filePath = path.join(LOG_DIR, file);
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      // Use raw console here — we are the logger, and this runs at startup
      console.log(`[${timestamp()}] [日志清理] 删除 ${deleted} 个超过 ${days} 天的旧日志文件`);
    }
  } catch (err) {
    console.error(`[${timestamp()}] [日志清理] 出错:`, err.message);
  }
}

// --- Logger object ---
function writeLog(level, args) {
  const ts = `[${timestamp()}]`;

  // Console output (for nssm capture / dev mode)
  if (level === 'error') {
    console.error(ts, ...args);
  } else if (level === 'warn') {
    console.warn(ts, ...args);
  } else {
    console.log(ts, ...args);
  }

  // File output (date-stamped)
  try {
    const stream = getLogStream();
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    stream.write(`${ts} [${level.toUpperCase()}] ${msg}\n`);
  } catch (err) {
    // Silently ignore file write errors to avoid breaking the app
  }
}

const logger = {
  log: (...args) => writeLog('info', args),
  error: (...args) => writeLog('error', args),
  warn: (...args) => writeLog('warn', args),
  info: (...args) => writeLog('info', args),
  cleanupOldLogs,
};

module.exports = logger;
