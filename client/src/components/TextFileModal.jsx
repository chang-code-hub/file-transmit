import { useState, useRef, useEffect } from 'react';

const MAX_TEXT_SIZE = 2 * 1024 * 1024; // 2MB 上限，避免超大文本拖慢浏览器

/**
 * 新建 / 编辑文本文件弹窗：设置文件名与内容，确认后返回一个与 File 结构兼容的条目。
 * onSave({ index?, file: File, displayName: string, isText: true })
 */
export default function TextFileModal({ index = null, initialName = '', initialContent = '', onSave, onClose }) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const [error, setError] = useState('');
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const contentSize = new Blob([content]).size;

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入文件名');
      return;
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      setError('文件名不能包含 / 或 \\');
      return;
    }
    if (contentSize > MAX_TEXT_SIZE) {
      setError(`文本内容过大（${formatSize(contentSize)}），不能超过 ${formatSize(MAX_TEXT_SIZE)}`);
      return;
    }

    const fileName = /\.(txt|md|log|json|csv|xml|html|css|js|jsx|ts|tsx|yml|yaml|ini|conf|sh|bat|py|java|c|cpp|h|go|rs|sql)$/i.test(trimmed)
      ? trimmed
      : `${trimmed}.txt`;

    onSave({
      ...(index == null ? {} : { index }),
      file: new File([content], fileName, { type: 'text/plain;charset=utf-8' }),
      displayName: fileName,
      isText: true,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h2>📝 新建文本文件</h2>
        <form onSubmit={handleSubmit}>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-group">
            <label>文件名</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setError(''); }}
              placeholder="file_1.txt（不填扩展名将自动补 .txt）"
            />
            <div className="hint">
              默认按 file_1.txt、file_2.txt 自动编号；仅允许扩展名在管理员白名单中的类型
            </div>
          </div>

          <div className="form-group">
            <label>文件内容</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="请输入文本内容..."
              rows={12}
              style={{ fontFamily: 'Consolas, Monaco, monospace', fontSize: 13, lineHeight: 1.5 }}
            />
            <div className="hint">
              {content.length} 个字符 · {formatSize(contentSize)}
              {contentSize > MAX_TEXT_SIZE * 0.8 && (
                <span style={{ color: '#c53030' }}>（接近 {formatSize(MAX_TEXT_SIZE)} 上限）</span>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary">{index == null ? '添加到列表' : '保存修改'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(1) + ' ' + units[i];
}
