import { useState, useEffect } from 'react';

const DEFAULT_FILE_TYPES = {
  documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf', '.odt', '.ods', '.odp'],
  images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif'],
  archives: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso'],
  videos: ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v'],
  audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a'],
  code: ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bat', '.ps1'],
  custom: [],
};

export default function AdminPage() {
  const [password, setPassword] = useState(null);
  // IP 过滤是否生效：管理页可用但尚未登录时，也需要知道该不该显示这个标签
  const [ipFilterActive, setIpFilterActive] = useState(false);
  useEffect(() => {
    fetch('/api/access-status')
      .then((r) => r.json())
      .then((d) => setIpFilterActive(!!d.ipFilterActive))
      .catch(() => {});
  }, []);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState('general');
  const [cleaning, setCleaning] = useState(false);

  // Login form state
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Password change confirmation
  const [confirmPassword, setConfirmPassword] = useState('');

  const fetchSettings = async (pwd) => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/settings', {
        headers: { 'x-admin-password': pwd },
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        if (data.ipFilterEnabled !== undefined) setIpFilterActive(!!data.ipFilterEnabled);
      }
    } catch {}
    setLoading(false);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!loginPassword.trim()) return;
    setLoginLoading(true);
    setLoginError('');

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ password: loginPassword.trim() }),
      });

      if (res.ok) {
        const pwd = loginPassword.trim();
        setPassword(pwd);
        setLoginPassword('');
        fetchSettings(pwd);
      } else {
        const data = await res.json();
        setLoginError(data.error || '密码错误');
      }
    } catch {
      setLoginError('网络错误，请重试');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setPassword(null);
    setSettings(null);
    setMessage('');
  };

  const handleSave = async () => {
    // Validate password confirmation
    if (settings.adminPassword && settings.adminPassword !== confirmPassword) {
      setMessage('两次输入的密码不一致');
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-admin-password': password,
        },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (res.ok) {
        setConfirmPassword('');
        if (data.portChanged) {
          const newPort = data.settings.port;
          setSettings(data.settings);
          if (import.meta.env.DEV) {
            setMessage(`端口已切换至 ${newPort}，请重启 Vite 开发服务器（npm run dev）`);
          } else {
            setMessage(`端口已切换至 ${newPort}，即将跳转...`);
            setTimeout(() => {
              const newOrigin = window.location.origin.replace(/:\d+$/, '') + ':' + newPort;
              window.location.replace(newOrigin + '/#/admin');
            }, 800);
          }
          return;
        } else {
          setMessage('设置已保存');
          setSettings(data.settings);
          if (data.settings.ipFilterEnabled !== undefined) {
            setIpFilterActive(!!data.settings.ipFilterEnabled);
          }
        }
      } else {
        setMessage(data.error || '保存失败');
      }
    } catch {
      setMessage('网络错误');
    } finally {
      setSaving(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    setMessage('');
    try {
      const res = await fetch('/api/admin/cleanup', {
        method: 'POST',
        headers: { 'x-admin-password': password },
      });
      const data = await res.json();
      setMessage(data.success ? '清理任务已执行完成' : (data.error || '清理失败'));
    } catch {
      setMessage('网络错误');
    } finally {
      setCleaning(false);
    }
  };

  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const updateFileTypes = (category, value) => {
    setSettings(prev => ({
      ...prev,
      allowedFileTypes: {
        ...prev.allowedFileTypes,
        [category]: typeof value === 'string'
          ? value.split(',').map(s => s.trim()).filter(Boolean)
          : value,
      },
    }));
  };

  const toggleFileExtension = (category, ext) => {
    setSettings(prev => {
      const current = prev.allowedFileTypes?.[category] || [];
      const updated = current.includes(ext)
        ? current.filter(e => e !== ext)
        : [...current, ext];
      return {
        ...prev,
        allowedFileTypes: {
          ...prev.allowedFileTypes,
          [category]: updated,
        },
      };
    });
  };

  const updateIpFilter = (mode, field, value) => {
    setSettings(prev => ({
      ...prev,
      ipFilter: {
        ...prev.ipFilter,
        [mode]: {
          ...prev.ipFilter[mode],
          [field]: value,
        },
      },
    }));
  };

  // trustProxy: false=忽略转发头；true=采信；数组=仅信任列表内的代理
  const trustProxyMode = (() => {
    const tp = settings?.trustProxy;
    if (tp === true) return 'on';
    if (Array.isArray(tp)) return 'list';
    return 'off';
  })();

  // 上传 / 下载两路代理各自独立，互不影响，可以只开一路
  const updateProxy = (kind, field, value) => {
    const key = `${kind}Proxy`;
    setSettings(prev => ({
      ...prev,
      [key]: {
        ...(prev[key] || {}),
        [field]: value,
      },
    }));
  };

  // 上传完成后回调（webhook 列表，可配多个）
  const webhooks = Array.isArray(settings?.webhooks) ? settings.webhooks : [];
  const setWebhooks = (list) => setSettings(prev => ({ ...prev, webhooks: list }));
  const updateWebhook = (idx, field, value) => {
    setWebhooks(webhooks.map((w, i) => (i === idx ? { ...w, [field]: value } : w)));
  };
  const addWebhook = () => {
    if (webhooks.length >= 20) return;
    setWebhooks([...webhooks, { name: '', enabled: false, url: '', secret: '' }]);
  };
  const removeWebhook = (idx) => setWebhooks(webhooks.filter((_, i) => i !== idx));
  const moveWebhook = (idx, delta) => {
    const to = idx + delta;
    if (to < 0 || to >= webhooks.length) return;
    const list = [...webhooks];
    const [it] = list.splice(idx, 1);
    list.splice(to, 0, it);
    setWebhooks(list);
  };

  // Not logged in: show inline login form
  if (!password) {
    return (
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 24 }}>管理员登录</h1>
        <form onSubmit={handleLogin}>
          {loginError && <div className="alert alert-error">{loginError}</div>}
          <div className="form-group">
            <label>管理员密码</label>
            <input
              type="password"
              value={loginPassword}
              onChange={e => setLoginPassword(e.target.value)}
              placeholder="请输入管理员密码"
              autoFocus
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loginLoading} style={{ width: '100%' }}>
            {loginLoading ? '验证中...' : '登录'}
          </button>
        </form>
      </div>
    );
  }

  if (loading) {
    return <p style={{ textAlign: 'center', padding: 40, color: '#999' }}>加载中...</p>;
  }

  if (!settings) return null;

  const fileTypeCategories = Object.keys(settings.allowedFileTypes || DEFAULT_FILE_TYPES);

  const tabs = [
    { key: 'general', label: '⚙️ 基本设置' },
    { key: 'fileTypes', label: '📎 文件类型' },
    { key: 'security', label: '🛡️ 安全设置' },
    // IP 过滤完全没启用时不显示这个标签（管理页也还没登录，无法读 settings）
    ...(ipFilterActive ? [{ key: 'ipFilter', label: '🌐 IP 过滤' }] : []),
  ];

  return (
    <div>
      {message && (
        <div className={`alert ${message.includes('已保存') ? 'alert-success' : 'alert-error'}`}>
          {message}
        </div>
      )}

      {/* Tab navigation */}
      <div style={{
        display: 'flex',
        gap: 4,
        marginBottom: 18,
        borderBottom: '2px solid #e8f0fe',
        paddingBottom: 0,
      }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: tab === t.key ? 600 : 400,
              border: 'none',
              borderBottom: tab === t.key ? '2px solid #4a90d9' : '2px solid transparent',
              background: 'none',
              color: tab === t.key ? '#4a90d9' : '#666',
              cursor: 'pointer',
              marginBottom: -2,
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ maxHeight: '55vh', overflowY: 'auto', paddingRight: 8 }}>
        {tab === 'general' && (
          <section>
            <div className="form-group">
              <label>管理员密码（留空不修改）</label>
              <input
                type="password"
                value={settings.adminPassword || ''}
                onChange={e => {
                  updateSetting('adminPassword', e.target.value);
                  setConfirmPassword('');
                }}
                placeholder="输入新密码，留空则不修改"
              />
            </div>
            {settings.adminPassword && (
              <div className="form-group">
                <label>确认新密码</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="再次输入新密码"
                />
              </div>
            )}
            <div className="form-group">
              <label>端口</label>
              <input
                type="number"
                value={settings.port || 3000}
                onChange={e => updateSetting('port', parseInt(e.target.value) || 3000)}
                min={1}
                max={65535}
              />
              <div className="hint">修改后自动生效，无需重启。默认 3000</div>
            </div>
            <div className="form-group">
              <label>文件保存路径</label>
              <input
                type="text"
                value={settings.storagePath || ''}
                onChange={e => updateSetting('storagePath', e.target.value)}
              />
              <div className="hint">Windows 默认 files。<strong>修改后下次上传生效</strong>（已入库的旧记录仍指向原路径）</div>
            </div>
            <div className="form-group">
              <label>文件保留时长（小时）</label>
              <input
                type="number"
                value={settings.retentionHours || 24}
                onChange={e => updateSetting('retentionHours', parseInt(e.target.value) || 24)}
                min={1}
                max={720}
              />
              <div className="hint">超过此时长的文件将被自动清理，默认 24 小时。<strong>下次上传生效</strong>（已入库的过期时间不变）</div>
            </div>
            <div className="form-group">
              <label>手动清理</label>
              <button
                className="btn"
                onClick={handleCleanup}
                disabled={cleaning}
                style={{ padding: '8px 16px', fontSize: 13 }}
              >
                {cleaning ? '清理中...' : '立即清理过期文件'}
              </button>
              <div className="hint">立即执行一次过期文件清理任务（自动清理每30分钟执行一次）</div>
            </div>
          </section>
        )}

        {tab === 'fileTypes' && (
          <section>
            {fileTypeCategories.map(cat => {
              if (cat === 'custom') {
                return (
                  <div className="form-group" key="custom">
                    <label>🔧 自定义扩展名</label>
                    <input
                      type="text"
                      value={(settings.allowedFileTypes.custom || []).join(', ')}
                      onChange={e => updateFileTypes('custom', e.target.value)}
                      placeholder=".xyz, .dat, .bin"
                    />
                    <div className="hint">逗号分隔，例如: .xyz, .dat, .bin</div>
                  </div>
                );
              }

              const knownExtensions = DEFAULT_FILE_TYPES[cat] || [];
              const allowed = settings.allowedFileTypes[cat] || [];

              return (
                <div className="form-group" key={cat}>
                  <label style={{ textTransform: 'capitalize' }}>{cat}</label>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
                    gap: '6px 4px',
                    marginTop: 6,
                  }}>
                    {knownExtensions.map(ext => (
                      <label
                        key={ext}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 13,
                          cursor: 'pointer',
                          padding: '4px 6px',
                          borderRadius: 4,
                          background: allowed.includes(ext) ? '#e8f0fe' : '#f5f5f5',
                          transition: 'background 0.15s',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={allowed.includes(ext)}
                          onChange={() => toggleFileExtension(cat, ext)}
                          style={{ margin: 0 }}
                        />
                        {ext}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {tab === 'security' && (
          <section>
 
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="checkbox"
                checked={settings.blockEncryptedArchives || false}
                onChange={e => updateSetting('blockEncryptedArchives', e.target.checked)}
                id="allowEncrypted"
              />
              <label htmlFor="allowEncrypted" style={{ margin: 0 }}>阻止加密压缩文件上传</label>
            </div>

          
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="checkbox"
                checked={settings.detectArchiveByContent || false}
                onChange={e => updateSetting('detectArchiveByContent', e.target.checked)}
                id="detectByContent"
              />
              <label htmlFor="detectByContent" style={{ margin: 0 }}>通过文件内容判断是否为压缩文件</label>
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="checkbox"
                checked={settings.recursiveArchiveCheck || false}
                onChange={e => updateSetting('recursiveArchiveCheck', e.target.checked)}
                id="recursiveCheck"
              />
              <label htmlFor="recursiveCheck" style={{ margin: 0 }}>递归检测压缩包内文件</label>
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />
                
            <div className="form-group">
              <label>7z 可执行文件路径</label>
              <input
                type="text"
                value={settings.sevenZipPath || ''}
                onChange={e => updateSetting('sevenZipPath', e.target.value)}
                placeholder='例如 C:\Program Files\7-Zip\7z.exe'
              />
              <div className="hint">
                配置后递归检测时将调用 7z 解压嵌套压缩包判断是否加密，留空则仅通过文件名后缀判断。
                <strong>Linux 下加密检测与病毒检测都依赖 7z</strong>：
                <code>apt install p7zip-full</code>（或 <code>apt install 7zip</code>）。
                未安装时检测会静默降级为纯 JS 解析，并跳过解压与杀毒。
              </div>
            </div>

            <div className="form-group">
              <label>unrar 可执行文件路径（RAR 必需）</label>
              <input
                type="text"
                value={settings.unrarPath || ''}
                onChange={e => updateSetting('unrarPath', e.target.value)}
                placeholder="Linux 留空自动查找 unrar，例如 /usr/bin/unrar"
              />
              <div className="hint">
                <strong>7-Zip 26.x 已不支持原始 RAR（RAR 4.x）</strong>，遇到只会报
                「Cannot open the file as archive」，加密检测、解压、病毒检测全部落空。
                需安装 RARLAB 版 unrar（各发行版命令见 README「系统依赖安装」；
                发行版的 <code>unrar-free</code> 只支持 RAR5）。
              </div>
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="checkbox"
                checked={settings.enableVirusDetect || false}
                onChange={e => updateSetting('enableVirusDetect', e.target.checked)}
                id="enableVirusDetect"
              />
              <label htmlFor="enableVirusDetect" style={{ margin: 0 }}>启用病毒检测（解压-等待-对比）</label>
            </div>
            <div className="hint" style={{ marginTop: 4, marginBottom: 12 }}>
              上传后自动解压压缩包到临时目录，再手动触发 clamscan 主动扫描（Linux）；
              同时对比解压前后文件数量——若文件数减少，说明杀毒软件删除了可疑文件，上传同样被拒绝。
              依赖 7z 与 clamscan（Linux: <code>apt install p7zip-full clamav</code>）。
            </div>
            <div className="form-group">
              <label>clamscan 可执行文件路径（可留空）</label>
              <input
                type="text"
                value={settings.clamscanPath || ''}
                onChange={e => updateSetting('clamscanPath', e.target.value)}
                placeholder="/usr/bin/clamscan"
              />
              <div className="hint">
                留空则自动在 PATH 中查找 <code>clamscan</code>。Linux 通常为 <code>/usr/bin/clamscan</code>；
                Windows 无 clamscan，留空即可（将退回「解压-等待-对比」检测）。
                记得定期 <code>freshclam</code> 更新病毒库。
              </div>
            </div>

            <ToolStatusPanel password={password} />

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

            <h3 style={{ fontSize: 14, marginBottom: 10, color: '#555' }}>下载令牌（服务端脚本用）</h3>
            <div className="hint" style={{ marginBottom: 14 }}>
              Jenkins 等服务端脚本调用 <code>/api/download/*</code> 与 <code>/api/files</code> 时，
              请求头 <code>x-download-token</code> 必须带上这个令牌。
              <b>与管理员口令分开</b>：它只能读已发布的文件，改不了任何设置。
              未配置令牌时，这些接口一律 401。
            </div>
            <div className="form-group">
              <label>下载令牌</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={settings.downloadToken || ''}
                  onChange={e => setSettings(prev => ({ ...prev, downloadToken: e.target.value }))}
                  placeholder="留空则服务启动时自动生成"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    const bytes = new Uint8Array(24);
                    crypto.getRandomValues(bytes);
                    const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
                    setSettings(prev => ({ ...prev, downloadToken: token }));
                  }}
                  style={{ padding: '6px 12px', fontSize: 13, whiteSpace: 'nowrap' }}
                >
                  随机生成
                </button>
              </div>
              <div className="hint">
                保存后生效。把它填进 <code>webhooks/jenkins/config.json</code> 的
                <code> download_token</code>。清空即关闭（所有服务端下载调用都会 401）。
              </div>
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

            <h3 style={{ fontSize: 14, marginBottom: 10, color: '#555' }}>上传完成 Webhook</h3>
            <div className="hint" style={{ marginBottom: 14 }}>
              每次上传成功后，向<b>所有已启用</b>的地址并发 POST 一份 JSON：含<b>文件 ID</b>、
              <b>附件清单</b>（每个附件都带 <code>downloadUrl</code> 下载直链），以及分享链接、过期时间等。
              <b>异步发送</b>，回调慢或失败都不会影响上传本身；单个失败也不影响其它 webhook。
              仓库里有现成的接收脚本：<code>webhooks/mail/</code>（邮件通知）、
              <code>webhooks/jenkins/</code>（Jenkins 下载任务）。
            </div>

            <div className="form-group">
              <label>对外访问地址（用于拼下载链接，可留空）</label>
              <input
                type="text"
                value={settings.webhookPublicUrl || ''}
                onChange={e => setSettings(prev => ({ ...prev, webhookPublicUrl: e.target.value }))}
                placeholder="https://files.example.com"
              />
              <div className="hint">
                留空则用本次请求的 Host。通过域名/IP 或反向代理对外提供服务时，
                建议填成外部可访问的地址，否则附件下载链接可能是内网地址。
              </div>
            </div>
            <div className="form-group">
              <label>超时（毫秒，默认 10000）</label>
              <input
                type="number"
                min="1000"
                max="60000"
                value={settings.webhookTimeoutMs || 10000}
                onChange={e => setSettings(prev => ({ ...prev, webhookTimeoutMs: Number(e.target.value) }))}
              />
              <div className="hint">对所有 webhook 生效；超过该时间即放弃，不会拖住上传完成的响应。</div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
              <label style={{ margin: 0, fontWeight: 600 }}>Webhook 列表（{webhooks.length}）</label>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={addWebhook}
                disabled={webhooks.length >= 20}
                style={{ padding: '6px 14px', fontSize: 13 }}
              >
                + 添加 Webhook
              </button>
            </div>

            {webhooks.length === 0 && (
              <div className="hint" style={{ marginBottom: 12 }}>
                还没有配置任何 webhook。点「+ 添加 Webhook」新增，例如邮件通知或 Jenkins 下载任务。
              </div>
            )}

            {webhooks.map((wh, idx) => (
              <div key={idx} style={{
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                padding: '14px 16px',
                marginBottom: 14,
                background: wh.enabled ? '#fafafa' : '#f5f5f5',
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={!!wh.enabled}
                    onChange={e => updateWebhook(idx, 'enabled', e.target.checked)}
                    id={`whEnabled${idx}`}
                  />
                  <label htmlFor={`whEnabled${idx}`} style={{ margin: 0, flex: 1 }}>启用</label>
                  <button type="button" onClick={() => moveWebhook(idx, -1)} disabled={idx === 0}
                    style={{ border: '1px solid #ddd', background: '#fff', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                    title="上移">↑</button>
                  <button type="button" onClick={() => moveWebhook(idx, 1)} disabled={idx === webhooks.length - 1}
                    style={{ border: '1px solid #ddd', background: '#fff', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                    title="下移">↓</button>
                  <button type="button" onClick={() => removeWebhook(idx)}
                    style={{ border: '1px solid #f0c0c0', color: '#c53030', background: '#fff', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                    title="删除这一条">删除</button>
                </div>

                <div className="form-group">
                  <label>名称（可留空，仅用于日志区分）</label>
                  <input
                    type="text"
                    value={wh.name || ''}
                    onChange={e => updateWebhook(idx, 'name', e.target.value)}
                    placeholder="例如：邮件通知 / Jenkins 下载"
                    maxLength={40}
                  />
                </div>
                <div className="form-group">
                  <label>地址</label>
                  <input
                    type="text"
                    value={wh.url || ''}
                    onChange={e => updateWebhook(idx, 'url', e.target.value)}
                    placeholder="http://jenkins:8080/generic-webhook-trigger/invoke?token=xxx"
                    disabled={!wh.enabled}
                  />
                  <div className="hint">
                    支持 <code>http(s)://</code>；请求头带 <code> x-webhook-event: upload.completed</code>。
                    {wh.name ? <>, 日志中标为 <code>[Webhook:{wh.name}]</code></> : null}
                  </div>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>签名密钥（可留空）</label>
                  <input
                    type="password"
                    value={wh.secret || ''}
                    onChange={e => updateWebhook(idx, 'secret', e.target.value)}
                    placeholder="留空则不签名"
                    disabled={!wh.enabled}
                    autoComplete="off"
                  />
                  <div className="hint">
                    配置后请求头带 <code> x-webhook-signature: sha256=&lt;hex&gt;</code>，
                    为 <code>HMAC-SHA256(密钥, 原始请求体)</code>，接收方可校验来源与防篡改。
                  </div>
                </div>
              </div>
            ))}

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

            <h3 style={{ fontSize: 14, marginBottom: 10, color: '#555' }}>代理转发</h3>
            <div className="hint" style={{ marginBottom: 14 }}>
              上传与下载<b>分开配置</b>，可以只配其中一路：启用的那一路转发到远程代理服务
              （本机不查数据库、不读文件），未启用的走本机实现。
              管理接口（<code>/api/admin</code> 等）始终走本机。
              地址填到 <code>/api</code> 的上一层，转发时自动补 <code>/api</code> + 原始路径，
              例如 <code>http://nexusoss.org/repository</code>，
              <code>/api/upload/history</code> 转发到
              <code>http://nexusoss.org/repository/api/upload/history</code>。
            </div>

            {['upload', 'download'].map(kind => {
              const key = `${kind}Proxy`;
              const proxy = settings[key] || {};
              const label = kind === 'upload' ? '上传' : '下载';
              const interfaces = kind === 'upload'
                ? '/api/upload/*（init / chunk / complete / history / validate-ids）'
                : '/api/download/*（详情与文件下载）';
              return (
                <div key={key} style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  padding: '14px 16px',
                  marginBottom: 14,
                  background: '#fafafa',
                }}>
                  <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                    <input
                      type="checkbox"
                      checked={proxy.enabled || false}
                      onChange={e => updateProxy(kind, 'enabled', e.target.checked)}
                      id={`${key}Enabled`}
                    />
                    <label htmlFor={`${key}Enabled`} style={{ margin: 0 }}>
                      启用{label}代理转发（{label}走远程）
                    </label>
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>{label}代理服务地址（/api 的上一层）</label>
                    <input
                      type="text"
                      value={proxy.baseUrl || ''}
                      onChange={e => updateProxy(kind, 'baseUrl', e.target.value)}
                      placeholder="http://nexusoss.org/repository"
                      disabled={!proxy.enabled}
                    />
                    <div className="hint">
                      转发范围：<code>{interfaces}</code>；留空或关闭则该部分走本机实现。
                    </div>
                    {proxy.enabled && proxy.baseUrl && (
                      <div className="hint">
                        预览：<code>{`${String(proxy.baseUrl).replace(/\/+$/, '')}/api/${kind}/history`}</code>
                      </div>
                    )}
                  </div>

                  {kind === 'download' && (
                    <div className="form-group" style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      marginTop: 12, paddingTop: 12, borderTop: '1px dashed #ddd', marginBottom: 0,
                    }}>
                      <input
                        type="checkbox"
                        checked={settings.preferLocalDownload || false}
                        onChange={e => updateSetting('preferLocalDownload', e.target.checked)}
                        id="preferLocalDownload"
                        disabled={!proxy.enabled}
                      />
                      <label htmlFor="preferLocalDownload" style={{ margin: 0 }}>
                        下载优先本地
                      </label>
                    </div>
                  )}
                  {kind === 'download' && settings.preferLocalDownload && (
                    <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
                      开启后，下载请求先看<b>本机磁盘</b>有没有该文件：
                      有就直接本机出（省一次远程往返），本机没有才转发上游。
                      未勾选时一律走上面配置的远程代理。
                    </div>
                  )}
                </div>
              );
            })}

          </section>
        )}

        {tab === 'ipFilter' && (
          <section>
            <div className="hint" style={{ marginBottom: 12 }}>
              当前状态：              <strong style={{ color: ipFilterActive ? '#276749' : '#c53030' }}>
                {ipFilterActive ? '已启用，保存后立即生效' : '未启用 —— 上传/下载均可访问'}
              </strong>
              。
            </div>
            <h3 style={{ fontSize: 14, marginBottom: 10, color: '#555' }}>反向代理 / 真实 IP</h3>
            <div className="hint" style={{ marginBottom: 12 }}>
              经 nginx 等反向代理时，socket 地址只是代理节点 IP，真实客户端 IP 在
              <code> X-Forwarded-For</code> / <code> X-Real-IP</code> 头里。
              <strong>仅当本服务确实在受信任代理之后时才开启</strong>，否则攻击者可伪造这些头绕过 IP 过滤。
            </div>

            <div className="form-group">
              <label>是否采信转发头（trustProxy）</label>
              <select
                value={trustProxyMode}
                onChange={e => {
                  const v = e.target.value;
                  if (v === 'off') updateSetting('trustProxy', false);
                  else if (v === 'on') updateSetting('trustProxy', true);
                  else updateSetting('trustProxy', Array.isArray(settings.trustProxy) ? settings.trustProxy : ['127.0.0.1']);
                }}
              >
                <option value="off">否 —— 只用 socket 地址（默认，防伪造）</option>
                <option value="on">是 —— 采信转发头（确实在代理之后时）</option>
                <option value="list">仅信任指定代理 —— 远端地址命中列表才采信</option>
              </select>
              <div className="hint">
                直连部署选「否」；Nginx 同机可选「是」或「仅信任 127.0.0.1」更稳妥。
              </div>
            </div>

            {trustProxyMode === 'list' && (
              <div className="form-group">
                <label>受信任代理地址（每行一个）</label>
                <textarea
                  rows={3}
                  value={(Array.isArray(settings.trustProxy) ? settings.trustProxy : []).join('\n')}
                  onChange={e => updateSetting('trustProxy', e.target.value.split('\n').map(x => x.trim()).filter(Boolean))}
                  placeholder={'127.0.0.1\n10.0.0.0/8\n172.16.0.1'}
                />
                <div className="hint">支持 CIDR（10.0.0.0/8）、连字符范围（10.0.0.1-10.0.0.50）、精确 IP。</div>
              </div>
            )}

            <div className="hint" style={{ marginTop: 4, marginBottom: 16 }}>
              你的 nginx 配置已是标准写法，无需改动：<br />
              <code>proxy_set_header X-Real-IP $remote_addr;</code><br />
              <code>proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;</code>
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

            <h3 style={{ fontSize: 14, marginBottom: 10, color: '#555' }}>上传页面</h3>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="checkbox"
                checked={settings.ipFilter?.upload?.enabled || false}
                onChange={e => updateIpFilter('upload', 'enabled', e.target.checked)}
                id="uploadIpEnabled"
              />
              <label htmlFor="uploadIpEnabled" style={{ margin: 0 }}>启用上传页 IP 过滤</label>
            </div>
            <div className="form-group">
              <label>过滤模式</label>
              <select
                value={settings.ipFilter?.upload?.mode || 'allow'}
                onChange={e => updateIpFilter('upload', 'mode', e.target.value)}
              >
                <option value="allow">允许列表（白名单）</option>
                <option value="deny">禁止列表（黑名单）</option>
              </select>
            </div>
            <div className="form-group">
              <label>IP 列表（每行一个）</label>
              <textarea
                value={(settings.ipFilter?.upload?.list || []).join('\n')}
                onChange={e => updateIpFilter('upload', 'list', e.target.value.split('\n').filter(Boolean))}
                rows={5}
                placeholder={"192.168.1.0/24\n10.0.0.1-10.0.0.255\n192.168.1.100"}
              />
              <div className="hint">
                支持三种格式：<br />
                • CIDR 前缀表示法：192.168.1.0/24<br />
                • 连字符范围表示法：192.168.1.1-192.168.1.100<br />
                • IP 地址列表：每行一个 IP 地址
              </div>
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #e0e0e0' }} />

            <h3 style={{ fontSize: 14, marginBottom: 10, color: '#555' }}>下载页面</h3>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="checkbox"
                checked={settings.ipFilter?.download?.enabled || false}
                onChange={e => updateIpFilter('download', 'enabled', e.target.checked)}
                id="downloadIpEnabled"
              />
              <label htmlFor="downloadIpEnabled" style={{ margin: 0 }}>启用下载页 IP 过滤</label>
            </div>
            <div className="form-group">
              <label>过滤模式</label>
              <select
                value={settings.ipFilter?.download?.mode || 'allow'}
                onChange={e => updateIpFilter('download', 'mode', e.target.value)}
              >
                <option value="allow">允许列表（白名单）</option>
                <option value="deny">禁止列表（黑名单）</option>
              </select>
            </div>
            <div className="form-group">
              <label>IP 列表（每行一个）</label>
              <textarea
                value={(settings.ipFilter?.download?.list || []).join('\n')}
                onChange={e => updateIpFilter('download', 'list', e.target.value.split('\n').filter(Boolean))}
                rows={5}
                placeholder={"192.168.1.0/24\n10.0.0.1-10.0.0.255\n192.168.1.100"}
              />
              <div className="hint">
                支持三种格式：<br />
                • CIDR 前缀表示法：192.168.1.0/24<br />
                • 连字符范围表示法：192.168.1.1-192.168.1.100<br />
                • IP 地址列表：每行一个 IP 地址
              </div>
            </div>
          </section>
        )}
      </div>

      <button
        className="btn btn-primary"
        onClick={handleSave}
        disabled={saving}
        style={{ width: '100%', padding: '14px', fontSize: 16, marginTop: 8 }}
      >
        {saving ? '保存中...' : '保存设置'}
      </button>
    </div>
  );
}

/**
 * 依赖工具体检面板
 *
 * Linux 上「加密压缩包检测」与「病毒检测」都依赖外部二进制（7z / clamscan）。
 * 缺失时后端会静默降级甚至完全不检测，日志里若不细看就像「一切正常」。
 * 这里把依赖状态直接摆在管理页，让部署时就能发现缺了什么。
 */
function ToolStatusPanel({ password }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/check-tools', {
        headers: { 'x-admin-password': password || '' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (password) load(); }, [password]);

  const row = (label, tool) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
      <span style={{ width: 90, color: '#555', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 600, color: tool.available ? '#276749' : '#c53030', fontSize: 13 }}>
        {tool.available ? '已就绪' : (tool.required === false ? '未启用' : '未找到')}
      </span>
      <span style={{ color: '#999', fontSize: 12, wordBreak: 'break-all' }}>
        {tool.resolvedPath || tool.configuredPath || '—'}
      </span>
    </div>
  );

  return (
    <div className="form-group" style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ fontSize: 13, color: '#555' }}>依赖工具体检</strong>
        <button type="button" className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={load} disabled={loading}>
          {loading ? '检测中...' : '重新检测'}
        </button>
      </div>

      {error && <div className="alert alert-warning" style={{ marginBottom: 8 }}>检测失败: {error}</div>}

      {status && (
        <>
          {row('7z', status.sevenZip)}
          {row('unrar', status.unrar || { available: false, required: true })}
          {row('clamscan', status.clamscan)}
          {status.warnings.length > 0 && (
            <div className="alert alert-warning" style={{ marginTop: 10, marginBottom: 0, fontSize: 12, lineHeight: 1.7 }}>
              {status.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          {status.warnings.length === 0 && (
            <div className="alert alert-success" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
              ✅ 加密检测与病毒检测依赖齐备，功能正常
            </div>
          )}
        </>
      )}
    </div>
  );
}
