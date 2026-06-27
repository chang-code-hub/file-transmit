import { useState, useEffect } from 'react';

export default function FileDetailModal({ fileId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!fileId) return;
    setLoading(true);
    setError('');

    fetch(`/api/download/${fileId}`)
      .then(res => {
        if (!res.ok) return res.json().then(d => Promise.reject(d));
        return res.json();
      })
      .then(setData)
      .catch(err => setError(err.error || '获取文件信息失败'))
      .finally(() => setLoading(false));
  }, [fileId]);

  const formatDate = (ts) => {
    return new Date(ts).toLocaleString('zh-CN');
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return size.toFixed(1) + ' ' + units[i];
  };

  const getFileIcon = (name) => {
    const ext = name.split('.').pop()?.toLowerCase();
    const iconMap = {
      pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
      jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', svg: '🖼️', webp: '🖼️',
      zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
      mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', wmv: '🎬',
      mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵',
      js: '📜', ts: '📜', py: '📜', java: '📜', html: '📜', css: '📜', json: '📜',
      txt: '📄', csv: '📄',
    };
    return iconMap[ext] || '📎';
  };

  if (!fileId) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>

        {loading && <p style={{ textAlign: 'center', padding: 30, color: '#999' }}>加载中...</p>}

        {error && <div className="alert alert-error">{error}</div>}

        {data && (
          <>
            <h2  >文件 ID: {data.id}</h2>

            {data.description && (
              <div style={{ marginTop: 12, padding: 12, background: '#f7fafc', borderRadius: 6 }}>
                <strong style={{ fontSize: 13, color: '#666' }}>描述：</strong>
                <span style={{ fontSize: 14 }}>{data.description}</span>
              </div>
            )}

            <div style={{ marginTop: 16, fontSize: 13, color: '#888', lineHeight: 2 }}>
              <div>上传时间: {formatDate(data.createdAt)}</div>
              <div>过期时间: {formatDate(data.expiresAt)}</div>
              <div>上传者 IP: {data.uploaderIp}</div>
              <div>文件数量: {data.files.length} 个</div>
            </div>

            <div style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 15, marginBottom: 10 }}>文件列表</h3>
              <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' }}>
                {data.files.map((f, i) => (
                  <div
                    key={f.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderBottom: i < data.files.length - 1 ? '1px solid #f0f0f0' : 'none',
                      background: i % 2 === 0 ? '#fafafa' : '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 20 }}>{getFileIcon(f.originalName)}</span>
                      <span style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.originalName}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                      <span style={{ fontSize: 12, color: '#999' }}>{formatSize(f.size)}</span>
                      <a
                        href={`/api/download/${data.id}/${encodeURIComponent(f.storedName)}`}
                        className="btn btn-primary btn-small"
                        download
                      >
                        下载
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
