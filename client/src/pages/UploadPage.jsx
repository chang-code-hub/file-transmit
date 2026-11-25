import { useState, useRef, useCallback } from 'react';
import HistoryButton, { addToHistory } from '../components/HistoryButton';
import FileDetailModal from '../components/FileDetailModal';
import TextFileModal from '../components/TextFileModal';
import UrlFileModal from '../components/UrlFileModal';

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
  const [linkCopied, setLinkCopied] = useState(false);
  const [textModal, setTextModal] = useState(null); // null | { index?: number, name, content }
  const [urlModal, setUrlModal] = useState(false);

  // Progress state
  const [fileProgress, setFileProgress] = useState([]);
  const [overallProgress, setOverallProgress] = useState(0);

  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  // 文本文件自动编号计数器（file_1.txt、file_2.txt …）
  const textSeqRef = useRef(0);

  /** 取下一个可用的 file_{n}.txt 名称，避开当前列表中已存在的名字 */
  const nextTextName = () => {
    const used = new Set(files.map(f => f.displayName));
    let name;
    do {
      textSeqRef.current += 1;
      name = `file_${textSeqRef.current}.txt`;
    } while (used.has(name));
    return name;
  };

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

  /** 将新建的文本文件加入待上传列表 */
  const handleAddTextFile = useCallback(({ file, displayName }) => {
    setFiles(prev => {
      const updated = [...prev];
      let name = displayName;
      let counter = 1;
      while (updated.some(existing => existing.displayName === name)) {
        const dotIdx = displayName.lastIndexOf('.');
        if (dotIdx > 0) {
          name = displayName.slice(0, dotIdx) + ` (${counter})` + displayName.slice(dotIdx);
        } else {
          name = displayName + ` (${counter})`;
        }
        counter++;
      }
      updated.push({ file, displayName: name, isText: true });
      return updated;
    });
    setError('');
  }, []);

  /** 重新编辑已添加的文本文件 */
  const handleEditTextFile = (index) => {
    const item = files[index];
    if (!item?.isText) return;
    // File#text 异步读出内容后再打开弹窗
    item.file.text().then(content => {
      setTextModal({ index, name: item.displayName, content });
    });
  };

  /** 更新已有文本文件（编辑） */
  const handleUpdateTextFile = useCallback(({ index, file, displayName }) => {
    setFiles(list => list.map((item, i) =>
      i === index ? { file, displayName, isText: true } : item
    ));
    setTextModal(null);
    setError('');
  }, []);

  /** 重名时补 (1)、(2)…，与服务端 uniqueStoredName 保持一致的观感 */
  const dedupeName = useCallback((list, desired) => {
    let name = desired;
    let counter = 1;
    while (list.some(existing => existing.displayName === name)) {
      const dotIdx = desired.lastIndexOf('.');
      name = dotIdx > 0
        ? desired.slice(0, dotIdx) + ` (${counter})` + desired.slice(dotIdx)
        : desired + ` (${counter})`;
      counter++;
    }
    return name;
  }, []);

  /** 从 URL 添加的条目进入待上传列表 */
  const handleAddUrlItem = useCallback(({ sourceUrl, fileName, host, size, mimeType }) => {
    setFiles(prev => {
      const name = dedupeName(prev, fileName);
      return [...prev, {
        isUrl: true,
        sourceUrl,
        host: !!host,
        size: Number(size) || 0,
        mimeType: mimeType || '',
        displayName: name,
        file: null,
      }];
    });
    setError('');
  }, [dedupeName]);

  /** 列表里直接改链接条目的文件名 */
  const handleRenameUrlItem = (index, name) => {
    setFiles(prev => prev.map((item, i) => (i === index ? { ...item, displayName: name } : item)));
  };

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

  const handleCopyLink = async () => {
    if (result?.fileId) {
      const link = `${window.location.origin}/#/down?f=${result.fileId}`;
      await navigator.clipboard.writeText(link);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  /**
   * Upload a single chunk. Returns the server response.
   * Throws if chunk fails or response is unexpected.
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

    const data = await res.json();
    // 校验服务端返回的分块序号是否匹配
    if (data.fileIndex !== fileIndex || data.chunkIndex !== chunkIndex) {
      throw new Error(`分块序号不匹配: 期望 ${fileIndex}/${chunkIndex}，收到 ${data.fileIndex}/${data.chunkIndex}`);
    }
    if (!data.received) {
      throw new Error(`分块 ${fileIndex}/${chunkIndex} 服务端未确认接收`);
    }
    return data;
  }

  /**
   * Upload all files sequentially with chunking.
   */
  const handleUpload = async () => {
    if (files.length === 0) {
      setError('请选择要上传的文件');
      return;
    }

    // 链接条目的文件名是可编辑输入框，可能被清空
    const emptyName = files.find(f => !String(f.displayName || '').trim());
    if (emptyName) {
      setError('文件名不能为空，请为每个条目填写文件名');
      return;
    }

    setUploading(true);
    setError('');
    setResult(null);
    setCopied(false);
    abortRef.current = new AbortController();

    const fileList = files.map(f => ({
      name: f.displayName,
      // 链接条目没有本地 File 对象：大小来自探测结果（可能为 0 = 未知）
      size: f.isUrl ? (f.size || 0) : f.file.size,
      mimeType: f.isUrl ? (f.mimeType || '') : (f.file.type || ''),
      // 服务端据此区分「托管下载」与「只存链接、下载时 302」
      ...(f.isUrl ? { sourceUrl: f.sourceUrl, host: !!f.host } : {}),
    }));

    // Initialize file progress tracking
    const fp = fileList.map((f) => ({
      name: f.name,
      isUrl: !!f.sourceUrl,
      host: f.host !== false,
      chunks: f.sourceUrl ? 0 : Math.ceil(f.size / CHUNK_SIZE),
      uploaded: 0,
      status: 'waiting', // waiting | uploading | verifying | done | error
    }));
    setFileProgress(fp);
    setOverallProgress(0);

    let fileId = null;
    let firstErrorMsg = '';
    const failedNames = [];
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

      const initData = await initRes.json();
      fileId = initData.fileId;
      const totalChunksOverall = fileList.reduce((sum, f) => sum + (f.sourceUrl ? 0 : Math.ceil(f.size / CHUNK_SIZE)), 0);
      let completedChunksTotal = 0;
      let successCount = 0;
      let urlCount = 0;
      let errorCount = 0;

      // Step 2: Upload each file sequentially, chunk by chunk
      // 单个文件失败不影响后续文件继续上传
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];

        // 链接条目不传分块：托管的由服务器在 complete 阶段下载，不托管的只写跳转记录
        if (f.isUrl) {
          urlCount++;
          continue;
        }

        const totalChunks = Math.ceil(f.file.size / CHUNK_SIZE);

        // Mark file as uploading
        setFileProgress(prev => prev.map((p, i) =>
          i === fi ? { ...p, status: 'uploading' } : p
        ));

        let fileFailed = false;
        for (let ci = 0; ci < totalChunks; ci++) {
          try {
            const start = ci * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, f.file.size);
            const chunkBlob = f.file.slice(start, end);

            await uploadChunk(fileId, fi, ci, totalChunks, chunkBlob);

            // Update progress
            completedChunksTotal++;
            const pct = totalChunksOverall > 0
              ? Math.round((completedChunksTotal / totalChunksOverall) * 1000) / 10
              : 100;
            setFileProgress(prev => prev.map((p, i) =>
              i === fi ? { ...p, uploaded: ci + 1 } : p
            ));
            setOverallProgress(pct);
          } catch (chunkErr) {
            // 单个分块失败 → 该文件标红，记录失败文件名，跳过剩余分块
            if (!firstErrorMsg) firstErrorMsg = chunkErr.message;
            failedNames.push(f.displayName);
            setFileProgress(prev => prev.map((p, i) =>
              i === fi ? { ...p, status: 'error' } : p
            ));
            fileFailed = true;
            errorCount++;
            break;
          }
        }

        if (!fileFailed) {
          // 所有分块上传完毕，标记为"检测中"（黄色）
          setFileProgress(prev => prev.map((p, i) =>
            i === fi ? { ...p, status: 'verifying' } : p
          ));
          successCount++;
        }
      }

      // 如果既没有本地文件传上去、也没有链接条目，报错
      if (successCount === 0 && urlCount === 0) {
        throw new Error(firstErrorMsg || '所有文件上传失败');
      }

      // 链接条目交给 complete 阶段处理（服务器下载 / 写跳转记录），先标成"处理中"
      if (urlCount > 0) {
        setFileProgress(prev => prev.map(p => (p.isUrl ? { ...p, status: 'verifying' } : p)));
      }

      // Step 3: Complete upload — reassemble on server
      // 即使部分文件失败，也提交已成功的文件
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

      // 服务端确认成功后，标记成功的文件为完成（绿色）
      setFileProgress(prev => prev.map(p =>
        p.status === 'verifying' ? { ...p, status: 'done' } : p
      ));
      await new Promise(resolve => setTimeout(resolve, 600));

      setResult({
        ...completeData,
        partialSuccess: errorCount > 0 || (completeData.failedFiles && completeData.failedFiles.length > 0),
        clientFailedNames: failedNames,
      });
      addToHistory(completeData.fileId);
      setFiles([]);
      setDescription('');
      setFileProgress([]);
      setOverallProgress(100);

    } catch (err) {
      setError(err.message || '上传失败');
      setFileProgress(prev => prev.map(p =>
        (p.status === 'uploading' || p.status === 'verifying') ? { ...p, status: 'error' } : p
      ));
    } finally {
      setUploading(false);
    }
  };

  // 链接条目交给服务器处理时没有可数的分块，总进度改用滚动条纹
  const serverPending = uploading && fileProgress.some(p => p.isUrl && p.status === 'verifying');

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
          <div className={`alert ${result.partialSuccess ? 'alert-warning' : 'alert-success'}`} style={{ fontSize: 16 }}>
            {result.partialSuccess
              ? `上传部分成功（${result.succeededFiles?.length || result.fileCount} 个成功，${result.failedFiles?.length || 0} 个失败）`
              : '上传成功！'}
          </div>

          {/* File-level result list */}
          <div style={{ textAlign: 'left', maxWidth: 500, margin: '12px auto 0' }}>
            {(result.succeededFiles || []).map((f, i) => (
              <div key={`ok-${i}`} style={{
                fontSize: 13, padding: '4px 8px',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ color: '#48bb78' }}>✅</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                {f.sourceUrl && (
                  <span
                    title={f.hosted ? `已托管，源地址：${f.sourceUrl}` : `下载时 302 跳转到：${f.sourceUrl}`}
                    style={{
                      fontSize: 11, flexShrink: 0, padding: '1px 5px', borderRadius: 4,
                      color: f.hosted === false ? '#b7791f' : '#2f855a',
                      background: f.hosted === false ? '#fffaf0' : '#f0fff4',
                      border: `1px solid ${f.hosted === false ? '#fbd38d' : '#c6f6d5'}`,
                    }}
                  >
                    {f.hosted === false ? '跳转' : '托管'}
                  </span>
                )}
                <span style={{ color: '#999', fontSize: 11, flexShrink: 0 }}>
                  {f.hosted === false && !f.size ? '—' : formatSize(f.size)}
                </span>
              </div>
            ))}
            {(result.failedFiles || []).map((f, i) => (
              <div key={`fail-${i}`} style={{
                fontSize: 13, padding: '4px 8px',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ color: '#e53e3e' }}>❌</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ color: '#e53e3e', fontSize: 11, flexShrink: 0 }}>{f.reason || '上传失败'}</span>
              </div>
            ))}
            {result.clientFailedNames && result.clientFailedNames.length > 0 && !result.failedFiles?.length && (
              result.clientFailedNames.map((name, i) => (
                <div key={`cfail-${i}`} style={{
                  fontSize: 13, padding: '4px 8px',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{ color: '#e53e3e' }}>❌</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                  <span style={{ color: '#e53e3e', fontSize: 11, flexShrink: 0 }}>网络错误</span>
                </div>
              ))
            )}
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

            {/* Download link */}
            <div style={{ marginTop: 24 }}>
              <div style={{ fontSize: 14, color: '#666', marginBottom: 8 }}>下载链接：</div>
              <div
                style={{
                  fontSize: 15,
                  color: '#1a73e8',
                  background: '#f0f7ff',
                  padding: '10px 20px',
                  borderRadius: 8,
                  display: 'inline-block',
                  wordBreak: 'break-all',
                  border: '1px solid #d0e3f7',
                }}
              >
                {window.location.origin}/#/down?f={result.fileId}
              </div>
              <div style={{ marginTop: 8 }}>
                <button
                  className="btn btn-primary btn-small"
                  onClick={handleCopyLink}
                >
                  {linkCopied ? '✅ 已复制' : '📋 复制下载链接'}
                </button>
              </div> 
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
          {!uploading && (
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
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={(e) => { e.stopPropagation(); setTextModal({ name: nextTextName(), content: '' }); }}
                >
                  📝 新建文本文件
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={(e) => { e.stopPropagation(); setUrlModal(true); }}
                >
                  🔗 从 URL 添加
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={e => handleFiles(e.target.files)}
              />
            </div>
          )}

          {/* File list */}
          {files.length > 0 && !uploading && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>
                已选择 {files.length} 个文件
              </h3>
              <div style={{ border: '1px solid #eee', borderRadius: 8, overflow: 'hidden' }}>
                {files.map((item, i) => {
                  const { displayName, isText, isUrl, file, sourceUrl, host } = item;
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderBottom: i < files.length - 1 ? '1px solid #f0f0f0' : 'none',
                        fontSize: 13,
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                        <span style={{ flexShrink: 0 }}>
                          {isUrl ? '🌐' : isText ? '📝' : '📎'}
                        </span>
                        {isUrl ? (
                          <input
                            type="text"
                            value={displayName}
                            onChange={e => handleRenameUrlItem(i, e.target.value)}
                            title={`${sourceUrl}（可直接改名）`}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              padding: '4px 8px',
                              border: '1px solid #e2e8f0',
                              borderRadius: 4,
                              fontSize: 13,
                            }}
                          />
                        ) : (
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {displayName}
                            {!isText && file && displayName !== file.name && (
                              <span style={{ color: '#999', fontSize: 11, marginLeft: 6 }}>
                                (原名: {file.name})
                              </span>
                            )}
                          </span>
                        )}
                      </div>

                      {isUrl && (
                        <span
                          title={host
                            ? '托管：上传时由服务器下载并保存该文件'
                            : '跳转：不保存文件，下载时 302 跳回原始地址'}
                          style={{
                            fontSize: 11,
                            padding: '2px 6px',
                            borderRadius: 4,
                            flexShrink: 0,
                            color: host ? '#2f855a' : '#b7791f',
                            background: host ? '#f0fff4' : '#fffaf0',
                            border: `1px solid ${host ? '#c6f6d5' : '#fbd38d'}`,
                          }}
                        >
                          {host ? '托管' : '跳转'}
                        </span>
                      )}

                      <span style={{ color: '#999', flexShrink: 0 }}>
                        {isUrl ? (item.size > 0 ? formatSize(item.size) : '—') : formatSize(file?.size)}
                      </span>
                      {isText && (
                        <button
                          className="btn btn-small btn-secondary"
                          onClick={(e) => { e.stopPropagation(); handleEditTextFile(i); }}
                        >
                          编辑
                        </button>
                      )}
                      <button
                        className="btn btn-small btn-danger"
                        onClick={(e) => { e.stopPropagation(); handleRemove(i); }}
                      >
                        移除
                      </button>
                    </div>
                  );
                })}
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
                  <span style={{ fontSize: 14, color: '#1a73e8' }}>
                    {serverPending ? '服务器处理中…' : `${overallProgress}%`}
                  </span>
                </div>
                <div style={{ background: '#eee', borderRadius: 6, height: 8, overflow: 'hidden' }}>
                  <div
                    className={serverPending ? 'progress-indeterminate' : undefined}
                    style={{
                      width: `${serverPending ? 100 : overallProgress}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #1a73e8, #4285f4)',
                      borderRadius: 6,
                      transition: 'width 0.5s ease',
                    }}
                  />
                </div>
              </div>

              {/* Per-file progress */}
              {fileProgress.map((fp, i) => {
                const isVerifying = fp.status === 'verifying';
                const isDone = fp.status === 'done';
                const isError = fp.status === 'error';
                const isUploading = fp.status === 'uploading';

                const bgColor = isError ? '#fff5f5' : isDone ? '#f0fff4' : isVerifying ? '#fffdf0' : '#f7fafc';
                const borderColor = isError ? '#fed7d7' : isDone ? '#c6f6d5' : isVerifying ? '#fbd38d' : '#e2e8f0';
                const barColor = isError ? '#e53e3e' : isDone ? '#48bb78' : isVerifying ? '#d69e2e' : '#1a73e8';

                const statusIcon = isDone ? '✅ ' : isError ? '❌ ' : isVerifying ? '🔍 ' : isUploading ? '⏳ ' : '⏸️ ';
                const statusText = fp.status === 'waiting' ? '等待中' :
                                   isDone ? '完成' :
                                   isError ? '失败' :
                                   isVerifying
                                     ? (fp.isUrl ? (fp.host ? '服务器下载中…' : '生成跳转记录…') : '检测中...')
                                     : `${fp.chunks > 0 ? Math.round(fp.uploaded / fp.chunks * 100) : 0}%`;

                // 链接条目没有分块可数：进行中用滚动条纹，其余按实际进度
                const barWidth = fp.chunks > 0
                  ? (fp.uploaded / fp.chunks * 100)
                  : (isVerifying ? 100 : 0);
                const indeterminate = fp.isUrl && fp.chunks === 0 && isVerifying;

                return (
                  <div
                    key={i}
                    style={{
                      padding: '10px 12px',
                      marginBottom: 6,
                      background: bgColor,
                      borderRadius: 8,
                      border: '1px solid',
                      borderColor: borderColor,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {statusIcon}{fp.name}
                      </span>
                      <span style={{ fontSize: 12, color: isVerifying ? '#b7791f' : '#666', flexShrink: 0, marginLeft: 8 }}>
                        {statusText}
                      </span>
                    </div>
                    {fp.status !== 'waiting' && (
                      <div style={{ background: '#eee', borderRadius: 4, height: 4, overflow: 'hidden' }}>
                        <div
                          className={indeterminate ? 'progress-indeterminate' : undefined}
                          style={{
                            width: `${barWidth}%`,
                            height: '100%',
                            background: barColor,
                            borderRadius: 4,
                            transition: 'width 0.4s ease',
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
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
            <>
              <button
                className="btn btn-primary"
                onClick={handleUpload}
                disabled={files.length === 0}
                style={{ width: '100%', padding: '14px', fontSize: 16 }}
              >
                上传 {files.length > 0 ? `(${files.length} 个文件)` : ''}
              </button>
              <button
                className="btn btn-secondary"
                style={{ width: '100%', padding: '10px', marginTop: 10, fontSize: 14 }}
                onClick={() => setTextModal({ name: nextTextName(), content: '' })}
              >
                📝 新建文本文件
              </button>
              <button
                className="btn btn-secondary"
                style={{ width: '100%', padding: '10px', marginTop: 10, fontSize: 14 }}
                onClick={() => setUrlModal(true)}
              >
                🔗 从 URL 添加
              </button>
            </>
          )}
        </>
      )}

      {selectedHistoryId && (
        <FileDetailModal
          fileId={selectedHistoryId}
          onClose={() => setSelectedHistoryId(null)}
        />
      )}

      {textModal && (
        <TextFileModal
          index={textModal.index ?? null}
          initialName={textModal.name || ''}
          initialContent={textModal.content || ''}
          onSave={textModal.index == null ? handleAddTextFile : handleUpdateTextFile}
          onClose={() => setTextModal(null)}
        />
      )}

      {urlModal && (
        <UrlFileModal
          onSave={handleAddUrlItem}
          onClose={() => setUrlModal(false)}
        />
      )}
    </div>
  );
}
