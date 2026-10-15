# 文件传输工具 (File Transmission Tool)

一个自托管的文件传输 Web 应用 —— 用户上传文件后获得一个 8 位随机 ID，其他人凭此 ID 即可下载。

![上传文件](screenshots/上传文件.png)

## 功能特性

### 管理面板
- **密码保护**：管理员密码在配置文件中设定，进入管理页需验证
- **文件类型管控**：预设常见文档、图片、压缩包、视频、音频、代码等类型，支持自定义扩展名
- **压缩包安全**：可配置是否拦截加密压缩包、是否递归检测、是否通过文件内容（magic bytes）判断文件类型
- **病毒检测**：解压压缩包后**手动触发 clamscan 主动扫描**（Linux），并辅以"解压-等待-对比"侧信道检测——若文件数减少说明杀毒软件删除了可疑文件，同样拒绝上传
- **IP 访问控制**：上传/下载可分别配置 IP 白名单或黑名单，支持以下格式：
  - CIDR 前缀：`192.168.1.0/24`
  - 连字符范围：`192.168.1.1-192.168.1.100`
  - 精确匹配：`10.0.0.1`
- **存储路径配置**：Windows 默认 `files`（无 D 盘则自动向后查找），Linux 默认 `/var/usr/FileTransmit/`
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
- 可配置代理转发，`/api/upload` 与 `/api/download` 转发到远程代理服务

## 技术栈

| 层面 | 技术 |
|------|------|
| 前端 | React (Vite 构建) |
| 后端 | Node.js + Express |
| 数据库 | DuckDB |
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

### 系统依赖安装（Linux）

加密压缩包检测与病毒检测依赖三个外部二进制，缺一会**静默降级甚至完全不触发**：

| 工具 | 作用 | 缺失时的后果 |
|------|------|--------------|
| **7z** / `7za` / `7zz` | 列挙、加密检测、解压、递归、病毒检测入口 | 加密检测退化为纯 JS；**不解压、不递归、不杀毒** |
| **unrar** | RAR 专用解包（7-Zip 26.x 已不支持 RAR4） | RAR 无法检测加密与内容 |
| **clamscan** | 主动病毒扫描 | 只剩「解压后文件列表对比」侧信道，无法识别已知病毒 |

> 需要 **RAR 支持**请装 RARLAB 版 `unrar`；发行版自带的 `unrar-free` **只支持 RAR5**，读 RAR4 会失败。

**Debian / Ubuntu（apt）**
```bash
sudo apt update
sudo apt install p7zip-full unrar clamav clamav-daemon
sudo freshclam                 # 更新病毒库，否则 clamscan 无法扫描
# 需要常驻自动更新时：
sudo systemctl enable --now clamav-freshclam
```
> `unrar` 在 Debian/Ubuntu 主仓库中即为 RARLAB 版；若源里只有 `unrar-free`，见下方「从源码安装 unrar」。

**RHEL / CentOS / Rocky / Alma（yum）**
```bash
sudo yum install epel-release      # 7z 与 clamav 在 EPEL 里
sudo yum install p7zip p7zip-plugins unrar clamav clamav-update
sudo freshclam
```
> 老版本 RHEL 的 `p7zip` 提供 `7za`，`p7zip-plugins` 补齐 RAR/7z 格式支持。

**Fedora / RHEL 8+（dnf）**
```bash
sudo dnf install epel-release
sudo dnf install p7zip p7zip-plugins unrar clamav clamav-update
sudo freshclam
```

**Arch Linux / Manjaro（pacman）**
```bash
sudo pacman -S p7zip unrar clamav
sudo freshclam
```
> `unrar` 在 `extra` 源中即为 RARLAB 版。

**openSUSE（zypper）**
```bash
sudo zypper install p7zip unrar clamav
sudo freshclam
```
> `unrar` 需启用 Packman 源；若只有 `unrar-free`，见下方「从源码安装 unrar」。

**Alpine（apk）**
```bash
sudo apk add p7zip unrar clamav clamav-daemon
sudo freshclam
```

**从源码安装 unrar（所有发行版通用，确保是 RARLAB 版）**
```bash
# x86_64
wget https://www.rarlab.com/rar/rarlinux-x64-712.tar.gz
# 或 arm64: https://www.rarlab.com/rar/rarlinux-arm64-712.tar.gz
tar -xzf rarlinux-x64-*.tar.gz
cd rar
sudo install -m 755 unrar /usr/local/bin/unrar
unrar                       # 能打印版本号即成功
```

**ClamAV 病毒库维护**
```bash
sudo freshclam              # 手动更新
sudo systemctl enable --now clamav-freshclam   # Debian/Ubuntu 自动更新
```
> 首次 `freshclam` 需下载数百 MB 病毒库，耗时较长。若报 `freshclam: ERROR: ... database lock`，
> 先停掉正在跑的更新服务：`sudo systemctl stop clamav-freshclam` 再执行。

**Windows**
- 7-Zip：安装 [7-Zip](https://www.7-zip.org/)，路径填 `C:\Program Files-Zipz.exe`
- RAR：安装 [WinRAR](https://www.rarlab.com/)，可选填 `unrar.exe` 路径
- ClamAV：Windows 无 `clamscan`，病毒检测自动退回「解压后文件列表对比」

**验证是否就绪**
```bash
7z | head -1        # 打印 7-Zip 版本
unrar               # 打印 UNRAR 版本
clamscan --version  # 打印 ClamAV 版本
```
或在**管理页 → 安全设置 → 依赖工具体检**里一键查看，等价于 `GET /api/admin/check-tools`。

### 安装为 Windows 服务

以**管理员身份**运行：

```batch
scripts\install-service.bat    # 安装服务
scripts\uninstall-service.bat  # 卸载服务
```

## 使用说明

### 上传文件

1. 打开首页即是上传页面，支持**点击选择文件**或**拖拽文件**到虚线区域
2. 可同时选择多个文件，重名文件会自动添加序号（如 `file(1).txt`）
3. 在底部输入框填写文件描述（可选），便于接收方了解文件内容
4. 点击"开始上传"，等待进度条完成

![上传文件](screenshots/上传文件.png)

### 分享文件

上传成功后，页面会显示一个醒目的 **8 位文件 ID**（如 `A3bF9kQ2`），点击即可复制。将这个 ID 通过任意方式（微信、邮件等）发送给接收方即可。

![上传成功](screenshots/上传文件成功.png)

你也可以点击右上角的**时钟图标**查看本地上传历史，批量验证哪些 ID 仍有效。

### 下载文件

1. 接收方打开网站，切换到**下载文件**页面
2. 输入 8 位文件 ID，点击"查看文件"

![下载页面](screenshots/下载文件.png)

3. 弹出文件详情窗口，展示描述信息和文件列表

![文件详情](screenshots/文件详情.png)

4. 点击文件名即可下载

### 管理设置

在页面顶部导航栏点击**管理设置**，输入管理员密码登录。

![管理设置](screenshots/管理设置.png)

#### 文件类型控制

勾选允许上传的文件类别，或在下方的"自定义扩展名"中添加额外的扩展名。未勾选的类型将被拒绝上传。

![文件类型设置](screenshots/文件类型设置.png)

#### 安全设置

- **拦截加密压缩包**：拒绝需要密码才能解压的压缩包，防止病毒绕过扫描
- **通过文件内容检测压缩包类型**：读取文件头（magic bytes）判断真实类型，而非仅依赖扩展名
- **递归检测压缩包内文件**：解压并检查压缩包内每一层文件的类型是否合法

- **7-Zip 路径**：用于压缩包递归检测的 7z 路径。Windows 填 `C:/Program Files/7-Zip/7z.exe`；Linux 留空则自动在 PATH 中查找 `7z`/`7za`/`7zz`
- **unrar 路径**：RAR 专用解包器。7-Zip 26.x 已不支持原始 RAR（RAR 4.x），Linux 必须装 RARLAB 版 `unrar`，否则 RAR 无法检测加密与内容
- **病毒检测**：上传后自动解压压缩包到临时目录，**手动触发 clamscan 主动扫描**（Linux，需安装 clamav 并定期 `freshclam` 更新病毒库）；同时对比解压前后文件数量（10~60秒等待），任一命中即拒绝该上传并自动清理
- **clamscan 路径**：留空则自动在 PATH 中查找。Windows 无 clamscan，留空即可（退回文件列表对比检测）

> **Linux 部署必读**：加密压缩包检测与病毒检测都依赖外部二进制（7z / unrar / clamscan）。
> 缺一不可时检测会**静默降级甚至完全不触发**，日志里若不细看就像「一切正常」。
> 各发行版（apt / yum / dnf / pacman / zypper / apk）的安装命令见
> [系统依赖安装](#系统依赖安装linux)。
>
> 依赖是否就绪可在**管理页 → 安全设置 → 依赖工具体检**里查看，或调用 `GET /api/admin/check-tools`（需管理员密码）。
> 启动与上传时若缺依赖，日志会给出明确告警，例如：
> ```
> [归档检测] 未找到可用的 7z，加密检测将退化为纯 JS 解析，递归解压与病毒检测被跳过
> [归档检查] 扫描 3 个文件: 压缩包 2 个 (7z=0, 魔数=2, 扩展名=0), 加密 1 个, 7z=未安装, clamscan=未安装
> ```
>
> 缺失 7z 时仍会做**纯 JS 加密检测**（ZIP/RAR4/RAR5/7z 头解析，含双重扩展名脱壳），
> 但不会解压、不递归、不杀毒；缺失 clamscan 时只剩「解压后文件列表对比」侧信道。
>
> **「7z 打不开」不等于「加密」**。7-Zip 对原始 `.rar`（RAR 4.x，7-Zip 已停止支持）、
> 损坏文件和伪装成压缩包的普通文件，都会输出同一种报错：
> ```
> ERROR: README.rar
> Cannot open the file as archive
> Can't open as archive: 1
> ```
> 这类文件既不能当加密拦掉（会误杀），也不能静默放过（等于没检测）。现在的处理是：
> 7z 打不开 → 纯 JS 再判一次 → 两条路径都认为加密才拦截，否则按「无法确认」记录并放行，
> 同时在日志与汇总里单独统计 `7z打不开 N 个`，提醒这类文件跳过了递归解压与病毒检测。
>
> **RAR 支持**：7-Zip 26.x 不支持原始 RAR（RAR 4.x），因此 RAR 交给 **unrar** 处理
> （须 RARLAB 版，发行版的 `unrar-free` 只支持 RAR5，见[系统依赖安装](#系统依赖安装linux)）。
> 安装后 RAR 的列挙、加密检测、解压、递归与病毒检测全部走 unrar，与 7z 链路一致。
> 管理页「安全设置」里可配置 `unrar 路径`，并可在「依赖工具体检」查看是否就绪。

![安全设置](screenshots/安全设置.png)

#### IP 访问控制

可为上传和下载分别配置 IP 过滤规则：

- **模式切换**：
  - **拒绝模式（deny）**：禁止列表中的 IP 访问，其余放行（黑名单）
  - **允许模式（allow）**：仅允许列表中的 IP 访问，其余拒绝（白名单）
- **地址格式**：支持 CIDR（`192.168.1.0/24`）、范围（`192.168.1.1-192.168.1.100`）、精确匹配（`10.0.0.1`）
- **启用开关**：关闭后 IP 过滤不生效

![IP过滤设置](screenshots/IP过滤设置.png)

#### 存储与保留

- **存储路径**：文件在服务器上的存放目录，支持相对路径和绝对路径
- **保留时长**：文件上传后保留的小时数，超时自动清理（每 30 分钟执行一次清理任务）

#### 代理转发

启用后上传与下载**不再查本地数据库、不读本地文件**，而是原样转发到远程代理服务。
管理接口始终走本机。

拓扑：

```
浏览器 -> 本服务 /api  ->  远程代理服务 /api  ->  存储 / 数据库
```

- **代理服务地址**：填到 `/api` 的**上一层**，转发时自动补 `/api` + 原始路径。
  例如填 `http://nexusoss.org/repository`，则
  `/api/upload/history` → `http://nexusoss.org/repository/api/upload/history`
- **走代理的接口**：`/api/upload/*`（含 init / chunk / complete / history / validate-ids）、
  `/api/download/*`（详情与文件下载），请求体（含 multipart 分块）原样透传
- **始终走本机**：`/api/admin/*`（管理设置）、`/api/access-status` 等
- **透传内容**：方法、路径、query string、请求头、请求体、响应状态码、响应头（含 `set-cookie`）、响应体
- **追加头**：`X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`，供上游识别真实来源
- **上游不可用**：返回 `502 代理服务不可用`
- **关闭或留空**：走本机实现（本地 DuckDB + 本地文件存储）

## 反向代理与真实 IP

上传、下载、IP 过滤和日志都需要**真实客户端 IP**。经 nginx / CDN / 负载均衡后，
TCP 对端只是代理节点的地址，真实 IP 在转发头里。

### Nginx 配置（标准写法，无需改动）

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 上传大文件需要
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
}
```

### 启用 trustProxy

默认 **`trustProxy: false`** —— 只用 socket 地址，**忽略一切转发头**。
这是安全默认值：转发头可被客户端伪造，若无脑采信，任何人都能伪造 IP 绕过 IP 过滤。

部署在反向代理之后时，在 `config.json` 里开启，或在 **管理页 → IP 过滤 → 反向代理 / 真实 IP** 里设置：

| 取值 | 行为 | 适用场景 |
|------|------|----------|
| `false`（默认） | 只用 socket 地址，转发头一律忽略 | 直接对外暴露、无代理 |
| `true` | 采信 `X-Forwarded-For` / `X-Real-IP` / `Forwarded` | 确认全站只经代理访问 |
| `["127.0.0.1", "10.0.0.0/8"]` | 仅当 socket 地址命中列表才采信转发头 | **推荐**：Nginx 同机或内网代理 |

```json
{ "trustProxy": ["127.0.0.1"] }
```

列表支持三种写法：精确 IP、CIDR（`10.0.0.0/8`）、连字符范围（`10.0.0.1-10.0.0.50`）。

### 解析优先级

1. `X-Forwarded-For`（`$proxy_add_x_forwarded_for` 逐跳追加；配置了信任列表时，
   从右往左跳过受信任代理，取第一个不受信地址——这是唯一无法被伪造的取法）
2. `X-Real-IP`
3. `Forwarded`（RFC 7239 标准头）
4. socket `remoteAddress`

所有结果统一归一化：去掉 IPv4-mapped IPv6（`::ffff:1.2.3.4`）、端口（`1.2.3.4:5678`）、
zone id（`fe80::1%eth0`），保证能与 IP 过滤规则直接比对。

### 生效范围

真实 IP 会用于：**上传**（初始化 / 分块 / 完成日志与入库）、**下载**（详情 / 单文件 / 打包下载日志）、
**IP 过滤**（上传/下载白名单黑名单）、**管理登录日志**、**代理转发追加的 X-Forwarded-For**。

### 验证

上传或下载一次，看服务端日志里的 `IP=` 字段：

```
[上传] 初始化成功: ID=..., IP=10.170.5.20     <- 真实客户端
[上传] 初始化成功: ID=..., IP=127.0.0.1       <- 仍在看 nginx 自己，说明 trustProxy 未开
```

## 配置说明

首次启动后会在项目根目录自动生成 `config.json`，主要配置项：

```json
{
  "port": 3000,
  "adminPassword": "admin123",
  "storagePath": "files",
  "retentionHours": 24,
  "allowedFileTypes": {
    "documents": [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".rtf", ".odt", ".ods", ".odp"],
    "images": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".ico", ".tiff", ".tif"],
    "archives": [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".iso"],
    "videos": [".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".mkv"],
    "audio": [".mp3", ".wav", ".flac", ".aac", ".ogg", ".wma", ".m4a"],
    "code": [".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb", ".php", ".html", ".css", ".json", ".xml", ".yaml", ".yml", ".sql", ".sh", ".bat", ".ps1"],
    "custom": []
  },
  "blockEncryptedArchives": true,
  "detectArchiveByContent": true,
  "recursiveArchiveCheck": true,
  "enableVirusDetect": false,
  "sevenZipPath": "C:\\Program Files\\7-Zip\\7z.exe",
  "unrarPath": "",
  "clamscanPath": "",
  "trustProxy": ["127.0.0.1"],
  "downloadProxy": { "enabled": false, "baseUrl": "" },
  "ipFilter": {
    "upload": { "enabled": false, "mode": "deny", "list": [] },
    "download": { "enabled": false, "mode": "allow", "list": [] }
  }
}
```

> **注意**：启动后请立即修改 `adminPassword`，默认密码为 `admin123`。

**配置项说明**

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `port` | `3000` | 监听端口 |
| `adminPassword` | `admin123` | 管理员密码，务必修改 |
| `storagePath` | `files` | 文件存储目录 |
| `retentionHours` | `24` | 文件保留小时数，超时自动清理 |
| `allowedFileTypes` | 预设 | 各类允许上传的扩展名 |
| `blockEncryptedArchives` | `true` | 拦截加密压缩包 |
| `detectArchiveByContent` | `false` | 按魔数判定压缩包，而非仅看扩展名 |
| `recursiveArchiveCheck` | `false` | 递归检测压缩包内嵌套压缩包 |
| `enableVirusDetect` | `false` | 启用病毒检测（clamscan + 解压前后对比） |
| `sevenZipPath` | `""` | 7z 路径，留空按平台在 PATH 查找 |
| `unrarPath` | `""` | unrar 路径（RAR 必需，7-Zip 26.x 不支持 RAR4） |
| `clamscanPath` | `""` | clamscan 路径，留空按 PATH 查找 |
| `trustProxy` | `false` | 是否采信 `X-Forwarded-For` 等转发头，见[反向代理与真实 IP](#反向代理与真实-ip) |
| `ipFilter` | 关闭 | 上传/下载 IP 白名单或黑名单 |
| `downloadProxy` | 关闭 | 将上传/下载请求转发到上游代理服务 |

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
│   │   └── archiveCheck.js   # 压缩包检测与病毒检测（7z 解压 + clamscan 主动扫描 + 解压-等待-对比）
│   └── utils/
│       └── ipMatch.js        # IP 匹配工具
├── client/
│   ├── index.html            # 页面入口，含 favicon / manifest 引用
│   ├── public/
│   │   ├── favicon.png       # 默认站点图标
│   │   ├── site.webmanifest  # PWA 图标清单
│   │   └── icons/            # Icons8 3D Fluency 图标（16/32/96）
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
├── screenshots/             # 截图文档
├── data.duckdb             # DuckDB 数据库文件
└── scripts/                 # 启动与服务管理脚本
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 管理员登录 |
| GET | `/api/admin/settings` | 获取配置 |
| PUT | `/api/admin/settings` | 更新配置 |
| GET | `/api/admin/stats` | 获取统计信息 |
| GET | `/api/admin/check-tools` | 检查 7z / unrar / clamscan 依赖是否就绪 |
| POST | `/api/upload/files` | 上传文件 |
| GET | `/api/upload/history` | 查询上传历史 |
| GET | `/api/upload/validate-ids` | 批量验证文件 ID 有效性 |
| GET | `/api/download/:fileId` | 查看文件详情 |
| GET | `/api/download/:fileId/:fileName` | 下载文件 |

## 许可

[MIT License](LICENSE)

### 使用声明

本项目以 [MIT 协议](LICENSE) 开源，项目地址：<https://github.com/chang-code-hub/file-transmit>

**使用、部署或二次分发本项目时，请在你的站点页脚或「关于」页面保留声明**，格式不限，需包含以下要素：

- 项目名称与仓库链接：[文件传输工具](https://github.com/chang-code-hub/file-transmit)
- 协议说明（MIT）
- 下方 Icons8 图标的署名（如沿用了本项目图标）

站内页脚默认已带这套声明（见 `client/src/App.jsx` 的 `.app-footer`），请勿删除；若自行替换了图标，可移除 Icons8 那一行，但项目声明需保留。

### 资源署名

站点图标来自 [Icons8](https://icons8.com) 的 3D Fluency 系列，按 [Icons8 许可](https://icons8.com/license) 需署名使用（或购买 Icons8 Pro 免署名）。站内页脚已包含署名链接；若你在其他地方使用这些图标，请保留同样的署名。

资源文件位于 `client/public/icons/`：
| 文件 | 尺寸 | 用途 |
|------|------|------|
| `favicon-16.png` | 16×16 | 浏览器标签页小图标 |
| `favicon-32.png` | 32×32 | 浏览器标签页图标 / `favicon.png` |
| `icon-96.png` | 96×96 | `apple-touch-icon` / PWA 图标 |

> 源图标包最大尺寸仅 96×96，故未提供 512×512 图标。
