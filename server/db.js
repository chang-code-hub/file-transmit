const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.db');

let db;

function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      uploader_ip TEXT DEFAULT '',
      uploader_ua TEXT DEFAULT '',
      user_id TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS file_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      mime_type TEXT DEFAULT '',
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
    CREATE INDEX IF NOT EXISTS idx_file_records_file_id ON file_records(file_id);
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// File operations
function createFile({ id, folderPath, description, ip, ua, userId, expiresAt }) {
  const now = Date.now();
  const stmt = getDb().prepare(`
    INSERT INTO files (id, folder_path, description, created_at, expires_at, uploader_ip, uploader_ua, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, folderPath, description, now, expiresAt, ip, ua, userId);
  return id;
}

function addFileRecord({ fileId, originalName, storedName, size, mimeType }) {
  const stmt = getDb().prepare(`
    INSERT INTO file_records (file_id, original_name, stored_name, size, mime_type)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(fileId, originalName, storedName, size, mimeType);
}

function getFileById(id) {
  const file = getDb().prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file) return null;
  const records = getDb().prepare('SELECT * FROM file_records WHERE file_id = ?').all(id);
  return { ...file, records };
}

function getFilesByUserId(userId) {
  const files = getDb().prepare(
    'SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(userId);
  return files.map(f => ({
    ...f,
    records: getDb().prepare('SELECT * FROM file_records WHERE file_id = ?').all(f.id),
  }));
}

function validateFileIds(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT id FROM files WHERE id IN (${placeholders})`
  ).all(...ids);
  return rows.map(r => r.id);
}

function deleteExpiredFiles(now) {
  const expired = getDb().prepare('SELECT * FROM files WHERE expires_at < ?').all(now);
  for (const f of expired) {
    getDb().prepare('DELETE FROM file_records WHERE file_id = ?').run(f.id);
    getDb().prepare('DELETE FROM files WHERE id = ?').run(f.id);
  }
  return expired;
}

// Settings operations
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).run(key, String(value));
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT * FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// Stats
function getStats() {
  const fileCount = getDb().prepare('SELECT COUNT(*) as count FROM files').get();
  const recordCount = getDb().prepare('SELECT COUNT(*) as count FROM file_records').get();
  const totalSize = getDb().prepare('SELECT SUM(size) as total FROM file_records').get();
  return {
    fileCount: fileCount.count,
    fileRecordCount: recordCount.count,
    totalSize: totalSize.total || 0,
  };
}

module.exports = {
  initDb,
  getDb,
  createFile,
  addFileRecord,
  getFileById,
  getFilesByUserId,
  validateFileIds,
  deleteExpiredFiles,
  getSetting,
  setSetting,
  getAllSettings,
  getStats,
};
