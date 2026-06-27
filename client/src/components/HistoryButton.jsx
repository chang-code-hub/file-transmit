import { useState } from 'react';

const STORAGE_KEY = 'file_transmit_history';

function getStoredIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addToHistory(fileId) {
  const ids = getStoredIds();
  if (!ids.includes(fileId)) {
    ids.unshift(fileId);
    if (ids.length > 50) ids.pop();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  }
}

export default function HistoryButton({ onSelect }) {
  const [show, setShow] = useState(false);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadHistory = async () => {
    setLoading(true);
    const storedIds = getStoredIds();

    if (storedIds.length === 0) {
      setHistory([]);
      setLoading(false);
      setShow(true);
      return;
    }

    try {
      // Validate which IDs still exist
      const res = await fetch(`/api/upload/validate-ids?ids=${storedIds.join(',')}`);
      const { validIds } = await res.json();

      // Clean invalid IDs from localStorage
      const cleaned = storedIds.filter(id => validIds.includes(id));
      if (cleaned.length !== storedIds.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
      }

      // Fetch detail for each valid ID
      const details = await Promise.all(
        cleaned.map(async (id) => {
          try {
            const r = await fetch(`/api/download/${id}`);
            if (r.ok) return await r.json();
          } catch {}
          return { id, error: true };
        })
      );

      setHistory(details.filter(Boolean));
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
      setShow(true);
    }
  };

  const handleOpen = () => {
    loadHistory();
  };

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

  return (
    <>
      <button className="btn btn-secondary" onClick={handleOpen}>
        📋 上传历史
      </button>

      {show && (
        <div className="modal-overlay" onClick={() => setShow(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 550 }}>
            <button className="modal-close" onClick={() => setShow(false)}>×</button>
            <h2>上传历史</h2>

            {loading ? (
              <p style={{ textAlign: 'center', padding: 20, color: '#999' }}>加载中...</p>
            ) : history.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 20, color: '#999' }}>暂无上传记录</p>
            ) : (
              <div style={{ marginTop: 12 }}>
                {history.map(item => (
                  <div
                    key={item.id}
                    className="history-item"
                    style={{
                      padding: '12px',
                      marginBottom: 8,
                      border: '1px solid #eee',
                      borderRadius: 8,
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onClick={() => {
                      setShow(false);
                      onSelect(item.id);
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f7fafc'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontFamily: 'monospace', fontSize: 16 }}>{item.id}</strong>
                      <span style={{ fontSize: 12, color: '#999' }}>
                        {item.files?.length || 0} 个文件
                      </span>
                    </div>
                    {item.description && (
                      <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>{item.description}</div>
                    )}
                    <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                      {formatDate(item.createdAt)} · 过期: {formatDate(item.expiresAt)}
                    </div>
                    {item.files && (
                      <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                        {item.files.slice(0, 3).map(f => f.originalName).join(', ')}
                        {item.files.length > 3 && ` ...等${item.files.length}个`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
