# Jenkins 下载任务 Webhook

Jenkins 收到「文件传输工具」的上传完成回调后，把文件下载到指定路径：
**用文件 ID 建一个文件夹，文件放进这个文件夹**。

```
/data/file-transmit/          <- base_dir
└── ABCD1234/                 <- 用 ID 建的文件夹
    ├── 报告.docx
    └── data.csv
```

纯 Python 标准库实现，节点上只需 Python 3.7+，不用 `pip install`。

## 文件

| 文件 | 说明 |
|------|------|
| `Jenkinsfile` | 流水线定义：接收 webhook → 解析 fileId → 下载 → 汇报 |
| `download.py` | 下载脚本（也支持手动/定时批量） |
| `extract_file_id.py` | 从 webhook body 或环境变量里提取 fileId |
| `config.example.json` | 配置模板，复制成 `config.json` 后填写 |

`config.json` 含下载令牌，**不要提交进版本库**（已在 `.gitignore` 里）。

## 配置项

```json
{
  "base_url": "http://192.168.1.10:3000",
  "download_token": "管理页「安全设置 → 下载令牌」的值",
  "base_dir": "/data/file-transmit",
  "timeout_seconds": 60
}
```

- `base_url` — 文件传输工具的**对外地址**，不带 `/api`。
- `download_token` — 必须与服务端 `config.json` 的 `downloadToken` 一致。
  服务端会校验请求头 `x-download-token`，没有令牌一律 401。
  该令牌**只能读文件**，改不了任何设置。
- `base_dir` — 下载根目录，脚本会在里面按 ID 建子目录；不存在会自动创建。

## 手动跑一次

```bash
cd webhooks/jenkins
cp config.example.json config.json      # 填好三项

python download.py --id ABCD1234                       # 只下这一个 ID
python download.py --ids AB12CD34,EF56GH78            # 批量
python download.py --since 1h --json                  # 最近 1 小时上传的
python download.py --since 24h --dry-run              # 只打印计划，不落盘
python download.py --all                              # 全部（谨慎）
```

退出码 0 = 全部成功，1 = 有失败。`--json` 会把结果以 JSON 打到 stdout。

## 接到 Jenkins

### 1. 装插件

**Generic Webhook Trigger Plugin**（Manage Jenkins → Plugins）。

### 2. 建 Job

新建 **Pipeline** 任务，Pipeline → Definition 选 **Pipeline script from SCM**，
指向本仓库，Script Path 填 `webhooks/jenkins/Jenkinsfile`。

### 3. 触发器配置

Jenkinsfile 里已经写好 `GenericTrigger`，关键参数：

- **Token**：`file-transmit-download` —— 必须与 webhook 地址里的 `?token=` 一致
- **Post content parameter**：`name=fileId`，`expression=$.fileId`（JSONPath）
- **Content type**：`application/json`

若你的 body 套了一层（如 `{data: {fileId: ...}}`），JSONPath 改成 `$.data.fileId`；
或留空，`extract_file_id.py` 会兜底解析整包 body。

### 4. 下发配置（不要把令牌提交进仓库）

Jenkins → **Manage Credentials** → 添加 **Secret file**，ID 填：

```
file-transmit-jenkins-config
```

文件内容就是 `webhooks/jenkins/config.json`（填好 `base_url` / `download_token` / `base_dir`）。
Jenkinsfile 在「准备」阶段会把它拷进工作区，构建结束时删掉。

### 5. 在管理页加一条 webhook

**管理设置 → 安全设置 → 上传完成 Webhook → + 添加 Webhook**

- 名称：`Jenkins 下载`
- 地址：`http://<jenkins>:8080/generic-webhook-trigger/invoke?token=file-transmit-download`
- 签名密钥：可留空（Generic Webhook Trigger 不校验 HMAC；要校验需另装
  Shared Library 自行验证）

上传一个文件后，Jenkins 会被触发并下载到 `/data/file-transmit/<fileId>/`。

## 没有 Jenkins 也能用

`download.py` 是独立脚本，可挂 cron / systemd timer 定时补漏：

```cron
# 每 10 分钟拉一次最近 15 分钟上传的文件
*/10 * * * * cd /opt/file-transmit/webhooks/jenkins && python3 download.py --since 15m --json >> /var/log/ft-download.log 2>&1
```

## 落盘规则

- 目录：`<base_dir>/<fileId>/`，**用 ID 建文件夹**
- 文件名：用**原始文件名**（`originalName`），不是服务端存储名
- 同名文件默认**跳过**（重跑安全），`--overwrite` 覆盖
- 文件名里的 `/` `\` 和 Windows 非法字符会替换成 `_`
- 先写 `.part` 临时文件再改名，避免半截文件被下游当成品用

## 接口与鉴权

脚本只用这三个接口，全部走 `x-download-token`：

| 接口 | 用途 |
|------|------|
| `GET /api/files?since=&limit=&offset=` | 按时间/分页列出文件（`--since`/`--all` 用） |
| `GET /api/download/:fileId` | 取该 ID 的附件清单 |
| `GET /api/download/:fileId/:name` | 下载单个文件 |

> 不能用 `/api/upload/history`：它按浏览器 cookie 的用户 ID 过滤，
> 服务端脚本没有那个 cookie，拿到的会是空列表。

## 常见问题

**401 下载令牌无效**
`config.json` 的 `download_token` 与服务端不一致；或服务端令牌是空的
（清空过之后没重启/没保存）。

**401 下载令牌未配置**
服务端 `config.json` 里 `downloadToken` 为空。服务启动时会自动生成，
也可以在管理页「安全设置 → 下载令牌」手动填一个并保存。

**webhook 打不到 Jenkins**
确认插件已装、`?token=` 与 Jenkinsfile 里的一致；
`curl -X POST 'http://jenkins:8080/generic-webhook-trigger/invoke?token=file-transmit-download' -H 'Content-Type: application/json' -d '{"fileId":"ABCD1234"}'` 手动试一次。

**文件已过期（410）**
`retentionHours` 到期后文件会被清理，webhook 触发时可能已经删了。
按需调大保留时长，或让下游尽快消费。

**Windows 节点**
`base_dir` 用 Windows 路径（`D:/data/file-transmit`）即可；
Jenkinsfile 里的 `sh` 步骤需要 Bash（Git Bash / WSL / Linux agent）。
