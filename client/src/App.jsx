import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import UploadPage from './pages/UploadPage';
import DownloadPage from './pages/DownloadPage';
import AdminPage from './pages/AdminPage';

export default function App() {
  const [access, setAccess] = useState(null);

  useEffect(() => {
    fetch('/api/access-status')
      .then(res => res.json())
      .then(data => setAccess(data))
      .catch(() => setAccess({ upload: false, download: false }));
  }, []);

  if (!access) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
        <p>加载中...</p>
      </div>
    );
  }

  return (
    <HashRouter>
      <div className="app">
        <nav className="top-nav">
          {access.upload && (
            <NavLink to="/upload" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              上传文件
            </NavLink>
          )}
          {access.download && (
            <NavLink to="/down" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              下载文件
            </NavLink>
          )}
          <NavLink to="/admin" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            管理设置
          </NavLink>
        </nav>
        <main className="main-content">
          <Routes>
            <Route path="/" element={
              access.upload ? <UploadPage /> : (access.download ? <Navigate to="/down" replace /> : <UploadPage />)
            } />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/down" element={<DownloadPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
