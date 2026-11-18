# 邮件通知 Webhook

把「文件传输工具」的上传完成事件转成邮件，发给指定的人。
邮件里只列**文件 ID、附件清单和下载链接**，不附带文件本身。

纯 Python 标准库实现，无需 `pip install`。

## 文件

| 文件 | 说明 |
|------|------|
| `send_mail.py` | HTTP 接收端 + 邮件发送 |
| `config.example.json` | 配置模板，复制成 `config.json` 后填写 |

## 快速开始

```bash
cd webhooks/mail
cp config.example.json config.json
# 编辑 config.json：填 SMTP 账号、收件人、签名密钥

python send_mail.py                  # 正式运行
python send_mail.py --dry-run        # 只打印邮件内容，不真正发信
python send_mail.py --port 8090      # 临时换端口
```

服务监听 `http://<host>:<port>/hook`，健康检查 `GET /health`。

## 配置项

```json
{
  "listen": { "host": "0.0.0.0", "port": 8090 },
  "secret": "与管理页该 webhook 的「签名密钥」保持一致",
  "dedupe_seconds": 300,
  "subject_template": "【文件传输】新上传 {fileId}（{fileCount} 个文件，{totalSize}）",
  "smtp": {
    "host": "smtp.example.com", "port": 465,
    "ssl": true, "starttls": false,
    "user": "notify@example.com", "password": "xxx",
    "from_addr": "文件传输工具 <notify@example.com>",
    "reply_to": "",
    "to": ["alice@example.com", "bob@example.com"]
  }
}
```

- `secret` — 留空则不校验签名。**建议填写**，否则任何人都能向你的收件人发信。
  必须与管理页里这个 webhook 的「签名密钥」完全一致。
- `dedupe_seconds` — 同一个 fileId 在该窗口内只发一次，防重复推送刷屏。默认 300 秒。
- `subject_template` — 占位符：`{fileId}` `{fileCount}` `{description}` `{totalSize}`。
  留空则用内置主题。
- `smtp.ssl` / `smtp.starttls` — 465 端口用 `ssl:true`；587 端口用 `starttls:true`。

## 接到管理页

在 **管理设置 → 安全设置 → 上传完成 Webhook** 里点「+ 添加 Webhook」：

- 名称：`邮件通知`（可选，只用于日志区分）
- 地址：`http://<这台机器的IP>:8090/hook`
- 签名密钥：与 `config.json` 的 `secret` 保持一致

## 邮件里有什么

```
文件传输工具：有新的文件上传完成。

文件 ID : ABCD1234
描述    : 季度报告
文件数  : 2
总大小  : 1.5 MB
上传时间: 2026-11-18 10:00:00
过期时间: 2026-11-19 10:00:00

附件列表（点击链接直接下载，不附带文件本身）：
------------------------------------------------------------
1. 报告.docx  (512.0 KB)
   http://<host>/api/download/ABCD1234/%E6%8A%A5%E5%91%8A.docx
2. data.csv  (1.0 MB)
   http://<host>/api/download/ABCD1234/data.csv
------------------------------------------------------------
文件详情页: http://<host>/#/down?f=ABCD1234
整包下载  : http://<host>/api/download/ABCD1234/zip
```

同时会发一份 HTML 版本（带表格和可点击的下载链接）。

> **下载链接的域名**取决于管理页「对外访问地址」（`webhookPublicUrl`）。
> 留空则用本次请求的 Host，走内网部署时链接可能是内网地址，收件人在外面打不开 ——
> 建议填成外部可访问的地址。

## 返回码

| 状态码 | 含义 |
|--------|------|
| 200 | 已接受（含重复通知，`duplicate: true`） |
| 400 | body 为空 / 非法 JSON / fileId 格式不对 |
| 401 | 签名缺失或不匹配（配置了 `secret` 时） |
| 413 | 请求体超过 1MB |
| 500 | 邮件发送失败（SMTP 连不上、认证失败等） |

## 常见问题

**file-transmit 日志里看到 502 / 连不上**
确认脚本已在跑，`curl http://<ip>:8090/hook -X POST -d '{}'` 能否连通；
防火墙是否放行了监听端口。

**收到 401**
`config.json` 的 `secret` 与管理页该 webhook 的「签名密钥」不一致，或一边填了一边没填。

**邮件发不出去**
看控制台日志。常见是 SMTP 端口与加密方式不匹配（465 用 `ssl`，587 用 `starttls`）、
账号密码错误，或服务商要求「应用专用密码」而非登录密码。

**想多个收件人**
`smtp.to` 写数组即可。

**Windows 上中文乱码**
用 `PYTHONIOENCODING=utf-8 python send_mail.py` 启动；或在 PowerShell 里
`chcp 65001` 后再运行。
