# 文件传输工具 (File Transmission Tool)

一个自托管的文件传输 Web 应用 —— 用户上传文件后获得一个 8 位随机 ID，其他人凭此 ID 即可下载。

## 功能特性

### 管理面板
- **密码保护**：管理员密码在配置文件中设定，进入管理页需验证
- **文件类型管控**：预设常见文档、图片、压缩包、视频、音频、代码等类型，支持自定义扩展名
- **压缩包安全**：可配置是否拦截加密压缩包、是否递归检测、是否通过文件内容（magic bytes）判断文件类型
- **杀毒扫描**：Windows 下支持上传后自动调用火绒杀毒软件静默扫描
- **IP 访问控制**：上传/下载可分别配置 IP 白名单或黑名单，支持以下格式：
  - CIDR 前缀：`192.168.1.0/24`
  - 连字符范围：`192.168.1.1-192.168.1.100`
  - 精确匹配：`10.0.0.1`
- **存储路径配置**：Windows 默认 `D:\FileTransmit\file`（无 D 盘则自动向后查找），Linux 默认 `/var/usr/FileTransmit/`
- **保留时长**：默认 24 小时，每 30 分钟自动清理过期文件及空目录

### 上传
- 多文件选择 + 拖拽上传
- 重名文件自动添加序号
- 可填写文件描述信息
- 上传后醒目展示 8 位文件 ID，凭此 ID 即可分享/下载
- 浏览器本地记录上传历史，自动清理已失效记录

### 下载
- 输入文件 ID 查看文件详情
- 详情弹窗展示描述、上传者信息（IP、时间、浏览器等）及文件清单
- 点击文件名直接下载

## 技术栈

| 层面 | 技术 |
|------|------|
| 前端 | React (Vite 构建) |
| 后端 | Node.js + Express |
| 数据库 | better-sqlite3 |
| 杀毒 | 火绒 (仅 Windows) |
| 平台 | Windows / Linux |

## 快速开始

### 方式一：一键脚本

**Windows**：双击 `scripts/start.bat`（自动安装依赖、构建前端、启动服务）

**Linux**：
```bash
chmod +x scripts/start.sh
./scripts/start.sh
```

### 方式二：手动启动

```bash
# 安装依赖
npm install

# 开发模式（前后端热重载）
npm run dev

# 生产模式（先构建再启动）
npm run build
npm start
```

服务默认监听 **3000** 端口，浏览器访问 `http://localhost:3000`。

### 安装为 Windows 服务

以**管理员身份**运行：

```batch
scripts\install-service.bat    # 安装服务
scripts\uninstall-service.bat  # 卸载服务
```

## 配置说明

首次启动后会在项目根目录自动生成 `config.json`，主要配置项：

```json
{
  "adminPassword": "admin123",        // 管理员密码，启动后请立即修改
  "storagePath": "D:\\FileTransmit\\file",  // 文件存储路径
  "retentionHours": 24,               // 文件保留时长（小时）
  "allowedFileTypes": { /* 按类别预设的允许扩展名 */ },
  "blockEncryptedArchives": true,     // 拦截加密压缩包
  "detectArchiveByContent": true,     // 通过文件内容检测压缩包
  "recursiveArchiveCheck": true,      // 递归检测压缩包内文件
  "enableAntivirusScan": true,        // 启用杀毒扫描（仅 Windows）
  "sevenZipPath": "C:\\Program Files\\7-Zip\\7z.exe",  // 7-Zip 路径（用于压缩包检测）
  "ipFilter": {
    "upload": { "enabled": false, "mode": "deny", "list": [] },
    "download": { "enabled": false, "mode": "allow", "list": [] }
  }
}
```

## 项目结构

```
file-transmit/
├── server/
│   ├── index.js              # Express 入口
│   ├── config.js             # 配置读写与默认值
│   ├── db.js                 # 数据库初始化与查询
│   ├── middleware/
│   │   ├── userId.js         # 永久 Cookie 用户标识
│   │   ├── ipFilter.js       # IP 黑白名单中间件
│   │   └── auth.js           # 管理员认证中间件
│   ├── routes/
│   │   ├── admin.js          # 管理 API
│   │   ├── upload.js         # 上传 API
│   │   └── download.js       # 下载 API
│   ├── services/
│   │   ├── cleanup.js        # 定期清理过期文件
│   │   └── avScan.js         # 杀毒扫描（Windows/火绒）
│   └── utils/
│       └── ipMatch.js        # IP 匹配工具
├── client/
│   └── src/
│       ├── pages/
│       │   ├── UploadPage.jsx     # 上传页
│       │   ├── DownloadPage.jsx   # 下载页
│       │   └── AdminPage.jsx      # 管理页
│       └── components/
│           ├── PasswordModal.jsx   # 管理员登录弹窗
│           ├── FileDetailModal.jsx # 文件详情弹窗
│           └── HistoryButton.jsx   # 上传历史按钮
├── config.json              # 运行时配置文件
└── scripts/                 # 启动与服务管理脚本
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 管理员登录 |
| GET | `/api/admin/settings` | 获取配置 |
| PUT | `/api/admin/settings` | 更新配置 |
| GET | `/api/admin/stats` | 获取统计信息 |
| POST | `/api/upload/files` | 上传文件 |
| GET | `/api/upload/history` | 查询上传历史 |
| GET | `/api/upload/validate-ids` | 批量验证文件 ID 有效性 |
| GET | `/api/download/:fileId` | 查看文件详情 |
| GET | `/api/download/:fileId/:fileName` | 下载文件 |

## 许可

[MIT License](LICENSE)
