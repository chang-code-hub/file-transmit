import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import FileDetailModal from '../components/FileDetailModal';

export default function DownloadPage() {
  const location = useLocation();
  const [fileId, setFileId] = useState('');
  const [lookupId, setLookupId] = useState(null);
  const [error, setError] = useState('');

  // Auto-fill fileId from URL query param (e.g. /#/down?f=XXXXXXXX)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const idFromUrl = params.get('f');
    if (idFromUrl && idFromUrl.trim().length === 8) {
      setFileId(idFromUrl.trim());
      setLookupId(idFromUrl.trim());
    }
  }, [location.search]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = fileId.trim();
    if (!trimmed) {
      setError('请输入文件 ID');
      return;
    }
    if (trimmed.length !== 8) {
      setError('文件 ID 为 8 位字符');
      return;
    }
    setError('');
    setLookupId(trimmed);
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 20 }}>下载文件</h1>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>输入文件 ID</label>
          <input
            type="text"
            value={fileId}
            onChange={e => { setFileId(e.target.value); setError(''); }}
            placeholder="请输入 8 位文件 ID"
            maxLength={8}
            style={{  fontSize: 18, textAlign: 'center', letterSpacing: 4 }}
            autoFocus
          />
          <div className="hint">输入上传后获得的 8 位字母数字 ID 来查看和下载文件</div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%', padding: '14px', fontSize: 16 }}
        >
          查看文件
        </button>
      </form>

      {lookupId && (
        <FileDetailModal
          fileId={lookupId}
          onClose={() => setLookupId(null)}
        />
      )}
    </div>
  );
}
