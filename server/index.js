const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { initDb, closeDb } = require('./db');
const { loadConfig, getConfig, updateConfig, isIpFilterActive } = require('./config');
const userIdMiddleware = require('./middleware/userId');
const logger = require('./utils/logger');
const { startCleanup } = require('./services/cleanup');

// Clean old log files on startup (retain 30 days)
logger.cleanupOldLogs();

const app = express();

// Hot restart: stored server reference for port switching without process restart
app.locals.httpServer = null;
app.locals.restartServer = function (newPort) {
  return new Promise((resolve, reject) => {
    function listen(port, res, rej) {
      const server = app.listen(port, () => {
        logger.log(`文件传输服务已启动: http://localhost:${port}`);
        app.locals.httpServer = server;
        if (res) res(server);
      });
      server.on('error', (err) => {
        logger.error(`端口 ${port} 启动失败:`, err.message);
        if (rej) rej(err);
      });
    }

    const oldServer = app.locals.httpServer;
    if (oldServer) {
      oldServer.close((err) => {
        if (err) {
          logger.error('关闭端口失败:', err);
          return reject(err);
        }
        logger.log('原端口已关闭');
        listen(newPort, resolve, reject);
      });
    } else {
      listen(newPort, resolve, reject);
    }
  });
};

// 反向代理：上传（/api/upload）与下载（/api/download）各一路代理，可只配其中一路，
// 启用的那一路转发到远程代理服务（本机不查库、不读文件），未启用的走本机实现。
// 管理接口（/api/admin 等）始终走本机。
// 必须在 body 解析器之前挂载，否则 express.json() 会消费掉请求流，
// 分块上传就无法原样透传给上游。
const proxyMiddleware = require('./middleware/proxy');
app.use('/api', proxyMiddleware());

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(userIdMiddleware);

/**
 * 下载令牌鉴权：Jenkins 等**服务端调用方**访问 /api/download/* 时用。
 * 头部 `x-download-token` 必须匹配 config.downloadToken；令牌为空 = 未启用，一律拒绝。
 * 与管理员口令分开：这个令牌只能读已发布的文件，改不了任何设置。
 *
 * 关键：**只拦服务端调用方，不拦浏览器**。浏览器是通过页面链接下载的，
 * 不会（也无法方便地）带 x-download-token；若一视同仁地拦，前端下载会全部 401。
 * 判定规则：请求头里**带了** x-download-token 就按服务端对待、严格校验；
 * 没带则视为浏览器，放行（浏览器的访问权限由 IP 过滤负责）。
 */
function downloadTokenAuth(req, res, next) {
  const given = req.headers['x-download-token'];

  // 浏览器路径：不带令牌头，不在此处拦截（IP 过滤已在 download 路由里生效）
  if (given === undefined || given === '') return next();

  const token = getConfig('downloadToken');
  if (!token) {
    return res.status(401).json({ error: '下载令牌未配置：请在管理页「安全设置」里生成' });
  }
  if (given !== token) {
    const clientIp = require('./utils/clientIp').clientIpOf(req);
    logger.log(`[下载令牌] 校验失败: IP=${clientIp}`);
    return res.status(401).json({ error: '下载令牌无效' });
  }
  next();
}

/**
 * 强制下载令牌鉴权：用于**只有服务端会调**的接口（如 /api/files）。
 * 与 downloadTokenAuth 的区别：不带令牌也拒绝 —— 这类接口对浏览器没有用处，
 * 不放行可避免它变成未鉴权的数据泄露口子。
 */
function requireDownloadToken(req, res, next) {
  const token = getConfig('downloadToken');
  const given = req.headers['x-download-token'];
  if (!token) {
    return res.status(401).json({ error: '下载令牌未配置：请在管理页「安全设置」里生成' });
  }
  if (!given || given !== token) {
    const clientIp = require('./utils/clientIp').clientIpOf(req);
    logger.log(`[下载令牌] 校验失败: IP=${clientIp}`);
    return res.status(401).json({ error: '下载令牌无效' });
  }
  next();
}

// IP filter access status (for frontend nav visibility)
const { checkIpAccess } = require('./middleware/ipFilter');
app.get('/api/access-status', (req, res) => {
  const clientIp = require('./utils/clientIp').clientIpOf(req) || '127.0.0.1';
  // ipFilterActive 供前端决定是否显示「IP 过滤」管理页入口（过滤未启用时不显示）
  res.json({
    upload: checkIpAccess('upload', clientIp),
    download: checkIpAccess('download', clientIp),
    ipFilterActive: isIpFilterActive(),
  });
});

// API routes（upload/download 未被代理转发时走本机实现）
// 服务端调用方（Jenkins 等）按时间/分页拉取文件列表：必须带下载令牌（纯服务端接口，浏览器不调）
app.get('/api/files', requireDownloadToken, async (req, res) => {
  try {
    const { listFiles } = require('./db');
    const files = await listFiles({
      since: Number(req.query.since) || 0,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });
    res.json({
      files: files.map(f => ({
        id: f.id,
        description: f.description,
        createdAt: f.created_at,
        expiresAt: f.expires_at,
        fileCount: f.records.length,
        files: f.records.map(r => ({
          originalName: r.original_name,
          storedName: r.stored_name,
          size: r.size,
          mimeType: r.mime_type,
        })),
      })),
    });
  } catch (err) {
    logger.error('[文件列表] 查询失败:', err.message);
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

app.use('/api/admin', require('./routes/admin'));
app.use('/api/upload', require('./routes/upload'));
// 服务端调用方（带 x-download-token）在此鉴权；浏览器不带令牌头，直接进 download 路由
app.use('/api/download', downloadTokenAuth, require('./routes/download'));

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
    await initDb();
    startCleanup();
    const PORT = getConfig('port') || process.env.PORT || 3000;
    await app.locals.restartServer(PORT);
    logger.log(`存储路径: ${getConfig('storagePath')}`);
    logger.log(`文件保留时长: ${getConfig('retentionHours')} 小时`);
    logger.log(`IP 过滤: ${isIpFilterActive() ? '已启用' : '未启用'}`);
    if (!getConfig('downloadToken')) {
      const generated = require('crypto').randomBytes(24).toString('base64url');
      updateConfig({ downloadToken: generated });
      logger.log('[下载令牌] 已自动生成，完整值在 config.json 的 downloadToken 字段（Jenkins 脚本需用它调用下载接口）');
    } else {
      logger.log('下载令牌: 已配置');
    }
    if (getConfig('adminPasswordIsGenerated')) {
      logger.warn('[安全] 管理员口令仍是 config.json 里的默认值 admin123 —— 请立刻在管理页「基本设置」修改');
    }
  } catch (err) {
    logger.error('启动失败:', err);
    process.exit(1);
  }
}

start();

// Ensure DuckDB data is flushed on exit
process.on('SIGINT', async () => {
  logger.log('收到 SIGINT，正在关闭数据库...');
  await closeDb();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.log('收到 SIGTERM，正在关闭数据库...');
  await closeDb();
  process.exit(0);
});
