import { useState, useEffect, useRef } from 'react';

const RESOLVE_DEBOUNCE_MS = 600;

/** 从 URL 路径猜一个文件名（拿不到响应头时的兜底） */
function guessNameFromUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return seg.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  } catch {
    return '';
  }
}

/** 是不是能直接发起探测的 http(s) 链接 */
function isProbeableUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

function formatSize(bytes) {
  if (!bytes) return '未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(1) + ' ' + units[i];
}

/**
 * 「从 URL 添加文件」弹窗。
 *
 * 输入链接后自动探测：先用 URL 路径解析文件名，路径里没有文件名时
 * 由服务端读 Content-Disposition 拿。解析结果可在输入框里改。
 * 勾选「托管」= 上传时由服务器下载该文件；不勾选 = 只存链接，下载时 302 跳回原地址。
 *
 * onSave({ sourceUrl, fileName, host, size, mimeType })
 */
export default function UrlFileModal({ onSave, onClose }) {
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [host, setHost] = useState(true);
  const [size, setSize] = useState(0);
  const [mimeType, setMimeType] = useState('');
  const [extensionAllowed, setExtensionAllowed] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [resolvedFrom, setResolvedFrom] = useState(''); // 已成功解析过的 URL
  const [note, setNote] = useState(''); // 非阻断提示（解析失败仍可继续）
  const [error, setError] = useState('');
  const urlRef = useRef(null);
  const seqRef = useRef(0);
  // 用 ref 而不是 state：探测请求跨越多次渲染，闭包里读到的必须是「此刻」的值，
  // 否则用户在探测途中改了文件名会被结果覆盖。
  const nameTouchedRef = useRef(false);

  useEffect(() => {
    urlRef.current?.focus();
  }, []);

  // 输入变化后自动探测（防抖，避免每敲一个字就打一次请求）
  useEffect(() => {
    const raw = url.trim();
    if (!isProbeableUrl(raw)) {
      setResolvedFrom('');
      setNote('');
      return;
    }
    const timer = setTimeout(() => {
      doResolve(raw);
    }, RESOLVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  async function doResolve(rawUrl) {
    const target = String(rawUrl || url).trim();
    if (!isProbeableUrl(target)) return;

    const seq = ++seqRef.current;
    setResolving(true);
    setNote('');
    try {
      const res = await fetch('/api/upload/url/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== seqRef.current) return; // 已经有更新的请求了
      if (!res.ok) throw new Error(data.error || '解析失败');

      setResolvedFrom(target);
      if (!nameTouchedRef.current) setFileName(data.fileName || guessNameFromUrl(target));
      setSize(Number(data.size) || 0);
      setMimeType(data.mimeType || '');
      setExtensionAllowed(data.extensionAllowed !== false);
      setError('');
    } catch (err) {
      if (seq !== seqRef.current) return;
      setResolvedFrom('');
      // 探测失败不拦人：用 URL 自己猜个名字照样能加，上传时服务端还会再校验
      const guessed = guessNameFromUrl(target);
      if (!nameTouchedRef.current && guessed) setFileName(guessed);
      setExtensionAllowed(true);
      setNote(err.message || '无法读取该链接的响应头');
    } finally {
      if (seq === seqRef.current) setResolving(false);
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    const raw = url.trim();
    if (!raw) {
      setError('请输入链接地址');
      return;
    }
    if (!isProbeableUrl(raw)) {
      setError('链接无效，需为 http:// 或 https:// 开头的合法地址');
      return;
    }
    const name = fileName.trim();
    if (!name) {
      setError('请填写文件名');
      return;
    }
    if (name.includes('/') || name.includes('\\')) {
      setError('文件名不能包含 / 或 \\');
      return;
    }

    onSave({
      sourceUrl: raw,
      fileName: name,
      host: !!host,
      size: Number(size) || 0,
      mimeType: mimeType || '',
    });
    onClose();
  };

  const parsed = !!resolvedFrom && resolvedFrom === url.trim();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <h2>🔗 从 URL 添加文件</h2>
        <form onSubmit={handleSubmit}>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-group">
            <label>文件链接</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={urlRef}
                type="text"
                value={url}
                onChange={e => { setUrl(e.target.value); setError(''); nameTouchedRef.current = false; }}
                placeholder="https://example.com/path/to/file.zip"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => doResolve(url)}
                disabled={resolving || !isProbeableUrl(url.trim())}
              >
                {resolving ? '解析中…' : '重新解析'}
              </button>
            </div>
            <div className="hint">
              {resolving
                ? '正在读取链接的文件名与大小…'
                : parsed
                  ? '已从链接解析出文件名，可直接修改'
                  : '输入后会自动解析：优先取 URL 里的文件名，URL 不含文件名时读取 HTTP 响应头'}
            </div>
            {note && (
              <div className="hint" style={{ color: '#b7791f' }}>
                ⚠️ 未能读取响应头（{note}），已按 URL 猜测文件名，请自行确认
              </div>
            )}
          </div>

          <div className="form-group">
            <label>文件名（可修改）</label>
            <input
              type="text"
              value={fileName}
              onChange={e => { setFileName(e.target.value); nameTouchedRef.current = true; setError(''); }}
              placeholder="将保存/展示的文件名"
            />
            <div className="hint">
              {size > 0 ? `远端大小：${formatSize(size)}` : '远端未提供大小信息'}
              {mimeType ? ` · 类型：${mimeType}` : ''}
              {!extensionAllowed && (
                <span style={{ color: '#c53030' }}> · 该扩展名不在管理员允许列表中，上传时可能被拒绝</span>
              )}
            </div>
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={host}
                onChange={e => setHost(e.target.checked)}
                style={{ marginTop: 3, width: 16, height: 16, accentColor: '#1a73e8' }}
              />
              <span>托管到服务器（由服务器下载这个文件）</span>
            </label>
            <div className="hint" style={{ marginLeft: 24 }}>
              {host
                ? '勾选：上传时服务器从该链接下载并保存文件，之后可离线下载、打包，也会经过归档与病毒检查。'
                : '不勾选：本服务只记录这个链接、不占存储；点下载时返回 302 跳转到原始地址，由源站直接提供文件。'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary">添加到列表</button>
          </div>
        </form>
      </div>
    </div>
  );
}
