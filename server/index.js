const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { initDb } = require('./db');
const { loadConfig, getConfig } = require('./config');
const userIdMiddleware = require('./middleware/userId');
const { startCleanup } = require('./services/cleanup');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(userIdMiddleware);

// IP filter access status (for frontend nav visibility)
const { checkIpAccess } = require('./middleware/ipFilter');
app.get('/api/access-status', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || '127.0.0.1';
  res.json({
    upload: checkIpAccess('upload', clientIp),
    download: checkIpAccess('download', clientIp),
  });
});

// API routes
app.use('/api/admin', require('./routes/admin'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/download', require('./routes/download'));

// Serve static frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(clientDist, 'index.html'));
  }
});

// Startup
async function start() {
  try {
    loadConfig();
    initDb();
    startCleanup();
    app.listen(PORT, () => {
      console.log(`文件传输服务已启动: http://localhost:${PORT}`);
      console.log(`存储路径: ${getConfig('storagePath')}`);
      console.log(`文件保留时长: ${getConfig('retentionHours')} 小时`);
    });
  } catch (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
}

start();
