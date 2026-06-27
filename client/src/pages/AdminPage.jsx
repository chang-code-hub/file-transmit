import { useState } from 'react';

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
        setSettings(await res.json());
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
    { key: 'ipFilter', label: '🌐 IP 过滤' },
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
              <div className="hint">Windows 默认 files</div>
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
              <div className="hint">超过此时长的文件将被自动清理，默认 24 小时</div>
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

            {settings.blockEncryptedArchives && (
              <>
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
                <div className="form-group">
                  <label>7z 可执行文件路径</label>
                  <input
                    type="text"
                    value={settings.sevenZipPath || ''}
                    onChange={e => updateSetting('sevenZipPath', e.target.value)}
                    placeholder='例如 C:\Program Files\7-Zip\7z.exe'
                  />
                  <div className="hint">配置后递归检测时将调用 7z 解压嵌套压缩包判断是否加密，留空则仅通过文件名后缀判断</div>
                </div>
              </>
            )}
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <input
                type="checkbox"
                checked={settings.enableAntivirusScan || false}
                onChange={e => updateSetting('enableAntivirusScan', e.target.checked)}
                id="enableAv"
              />
              <label htmlFor="enableAv" style={{ margin: 0 }}>上传后调用杀毒软件扫描（仅 Windows 下支持火绒）</label>
            </div>
          </section>
        )}

        {tab === 'ipFilter' && (
          <section>
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
