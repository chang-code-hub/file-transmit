import { useState, useRef, useCallback } from 'react';
import HistoryButton, { addToHistory } from '../components/HistoryButton';
import FileDetailModal from '../components/FileDetailModal';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB, must match server

export default function UploadPage() {
  const [files, setFiles] = useState([]);
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState(null);
  const [copied, setCopied] = useState(false);

  // Progress state
  const [fileProgress, setFileProgress] = useState([]);
  const [overallProgress, setOverallProgress] = useState(0);

  const fileInputRef = useRef(null);
  const abortRef = useRef(null);

  const handleFiles = useCallback((newFiles) => {
    const fileList = Array.from(newFiles);
    setFiles(prev => {
      const updated = [...prev];
      for (const f of fileList) {
        let name = f.name;
        let counter = 1;
        while (updated.some(existing => existing.displayName === name)) {
          const dotIdx = f.name.lastIndexOf('.');
          if (dotIdx > 0) {
            name = f.name.slice(0, dotIdx) + ` (${counter})` + f.name.slice(dotIdx);
          } else {
            name = f.name + ` (${counter})`;
          }
          counter++;
        }
        updated.push({ file: f, displayName: name });
      }
      return updated;
    });
    setError('');
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleRemove = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleCopyId = async () => {
    if (result?.fileId) {
      await navigator.clipboard.writeText(result.fileId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  /**
   * Upload a single chunk.
   */
  async function uploadChunk(fileId, fileIndex, chunkIndex, totalChunks, chunkBlob) {
    const formData = new FormData();
    formData.append('fileId', fileId);
    formData.append('fileIndex', fileIndex.toString());
    formData.append('chunkIndex', chunkIndex.toString());
    formData.append('totalChunks', totalChunks.toString());
    formData.append('chunk', chunkBlob);

    const res = await fetch('/api/upload/chunk', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '分块上传失败');
    }

    return res.json();
  }

  /**
   * Upload all files sequentially with chunking.
   */
  const handleUpload = async () => {
    if (files.length === 0) {
      setError('请选择要上传的文件');
      return;
    }

    setUploading(true);
    setError('');
    setResult(null);
    setCopied(false);
    abortRef.current = new AbortController();

    const fileList = files.map(f => ({
      name: f.displayName,
      size: f.file.size,
      mimeType: f.file.type || '',
    }));

    // Initialize file progress tracking
    const fp = fileList.map((f, i) => ({
      name: f.name,
      chunks: Math.ceil(f.size / CHUNK_SIZE),
      uploaded: 0,
      status: 'waiting', // waiting | uploading | done | error
    }));
    setFileProgress(fp);
    setOverallProgress(0);

    try {
      // Step 1: Initialize upload session
      const initRes = await fetch('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ files: fileList, description }),
      });

      if (!initRes.ok) {
        const data = await initRes.json();
        throw new Error(data.error || '初始化上传失败');
      }

      const { fileId } = await initRes.json();
      const totalChunksOverall = fileList.reduce((sum, f) => sum + Math.ceil(f.size / CHUNK_SIZE), 0);
      let completedChunksTotal = 0;

      // Step 2: Upload each file sequentially, chunk by chunk
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        const totalChunks = Math.ceil(f.file.size / CHUNK_SIZE);

        // Mark file as uploading
        setFileProgress(prev => prev.map((p, i) =>
          i === fi ? { ...p, status: 'uploading' } : p
        ));

        for (let ci = 0; ci < totalChunks; ci++) {
          const start = ci * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, f.file.size);
          const chunkBlob = f.file.slice(start, end);

          await uploadChunk(fileId, fi, ci, totalChunks, chunkBlob);

          // Update progress
          completedChunksTotal++;
          setFileProgress(prev => prev.map((p, i) =>
            i === fi ? { ...p, uploaded: ci + 1 } : p
          ));
          setOverallProgress(Math.round((completedChunksTotal / totalChunksOverall) * 100));
        }

        // Mark file as done
        setFileProgress(prev => prev.map((p, i) =>
          i === fi ? { ...p, status: 'done' } : p
        ));
      }

      // Step 3: Complete upload — reassemble on server
      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ fileId }),
      });

      if (!completeRes.ok) {
        const data = await completeRes.json();
        throw new Error(data.error || '完成上传失败');
      }

      const completeData = await completeRes.json();

      setResult(completeData);
      addToHistory(completeData.fileId);
      setFiles([]);
      setDescription('');
      setFileProgress([]);
      setOverallProgress(100);

    } catch (err) {
      setError(err.message || '上传失败');
      setFileProgress(prev => prev.map(p => ({ ...p, status: p.status === 'uploading' ? 'error' : p.status })));
    } finally {
      setUploading(false);
    }
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
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22 }}>文件上传</h1>
        <HistoryButton onSelect={id => setSelectedHistoryId(id)} />
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {result ? (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div className="alert alert-success" style={{ fontSize: 16 }}>
            上传成功！
          </div>
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 14, color: '#666', marginBottom: 8 }}>您的文件 ID：</div>
            <div
              style={{
                fontSize: 40, 
                fontWeight: 'bold',
                color: '#1a73e8',
                background: '#e8f0fe',
                padding: '16px 32px',
                borderRadius: 12,
                display: 'inline-block',
                letterSpacing: 4,
              }}
            >
              {result.fileId}
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary btn-small"
                onClick={handleCopyId}
              >
                {copied ? '✅ 已复制' : '📋 一键复制 ID'}
              </button>
            </div>
            <div style={{ marginTop: 12, fontSize: 13, color: '#999' }}>
              {result.fileCount} 个文件 · {new Date(result.expiresAt).toLocaleString('zh-CN')} 过期
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 24 }}
            onClick={() => setResult(null)}
          >
            继续上传
          </button>
        </div>
      ) : (
        <>
          {/* Drop zone */}
          <div
            style={{
              border: `2px dashed ${dragOver ? '#1a73e8' : '#ddd'}`,
              borderRadius: 10,
              padding: '40px 20px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? '#e8f0fe' : '#fafafa',
              transition: 'all 0.2s',
              marginBottom: 20,
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <div style={{ fontSize: 40, marginBottom: 10 }}>📁</div>
            <div style={{ fontSize: 15, color: '#666' }}>拖拽文件到此处上传</div>
            <div style={{ fontSize: 13, color: '#999', marginTop: 4 }}>或点击选择文件（支持多选）</div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => handleFiles(e.target.files)}
            />
          </div>

          {/* File list */}
          {files.length > 0 && !uploading && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>
                已选择 {files.length} 个文件
              </h3>
              <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' }}>
                {files.map(({ file, displayName }, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      borderBottom: i < files.length - 1 ? '1px solid #f0f0f0' : 'none',
                      fontSize: 13,
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      📎 {displayName}
                      {displayName !== file.name && (
                        <span style={{ color: '#999', fontSize: 11, marginLeft: 6 }}>
                          (原名: {file.name})
                        </span>
                      )}
                    </span>
                    <span style={{ color: '#999', margin: '0 12px', flexShrink: 0 }}>{formatSize(file.size)}</span>
                    <button
                      className="btn btn-small btn-danger"
                      onClick={(e) => { e.stopPropagation(); handleRemove(i); }}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upload progress */}
          {uploading && (
            <div style={{ marginBottom: 20 }}>
              {/* Overall progress */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>总进度</span>
                  <span style={{ fontSize: 14, color: '#1a73e8' }}>{overallProgress}%</span>
                </div>
                <div style={{ background: '#eee', borderRadius: 6, height: 8, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${overallProgress}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #1a73e8, #4285f4)',
                      borderRadius: 6,
                      transition: 'width 0.3s',
                    }}
                  />
                </div>
              </div>

              {/* Per-file progress */}
              {fileProgress.map((fp, i) => (
                <div
                  key={i}
                  style={{
                    padding: '10px 12px',
                    marginBottom: 6,
                    background: fp.status === 'error' ? '#fff5f5' : fp.status === 'done' ? '#f0fff4' : '#f7fafc',
                    borderRadius: 8,
                    border: '1px solid',
                    borderColor: fp.status === 'error' ? '#fed7d7' : fp.status === 'done' ? '#c6f6d5' : '#e2e8f0',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {fp.status === 'done' ? '✅ ' : fp.status === 'error' ? '❌ ' : fp.status === 'uploading' ? '⏳ ' : '⏸️ '}
                      {fp.name}
                    </span>
                    <span style={{ fontSize: 12, color: '#666', flexShrink: 0, marginLeft: 8 }}>
                      {fp.status === 'waiting' ? '等待中' :
                       fp.status === 'done' ? '完成' :
                       fp.status === 'error' ? '失败' :
                       `${fp.chunks > 0 ? Math.round(fp.uploaded / fp.chunks * 100) : 0}%`}
                    </span>
                  </div>
                  {fp.status !== 'waiting' && (
                    <div style={{ background: '#eee', borderRadius: 4, height: 4, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${fp.chunks > 0 ? (fp.uploaded / fp.chunks * 100) : 0}%`,
                          height: '100%',
                          background: fp.status === 'error' ? '#e53e3e' : fp.status === 'done' ? '#48bb78' : '#1a73e8',
                          borderRadius: 4,
                          transition: 'width 0.2s',
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Description */}
          {!uploading && (
            <div className="form-group">
              <label>文件描述（可选）</label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="请输入文件描述..."
                rows={3}
              />
            </div>
          )}

          {!uploading && (
            <button
              className="btn btn-primary"
              onClick={handleUpload}
              disabled={files.length === 0}
              style={{ width: '100%', padding: '14px', fontSize: 16 }}
            >
              上传 {files.length > 0 ? `(${files.length} 个文件)` : ''}
            </button>
          )}
        </>
      )}

      {selectedHistoryId && (
        <FileDetailModal
          fileId={selectedHistoryId}
          onClose={() => setSelectedHistoryId(null)}
        />
      )}
    </div>
  );
}
