/**
 * DuckDB 数据访问层（@duckdb/node-api 1.2.2-alpha.19）。
 *
 * 该版本的连接级快捷方法（conn.run / conn.runAndReadAll 等）传入 values 数组时会挂起，
 * 只有无参数调用才正常。因此这里所有查询统一走 prepared statement：
 *   prepare(sql) -> bind(values) -> run() / runAndReadAll()
 *
 * 其它差异：
 * - bind 直接接受裸 JS 值（string / number / bigint / boolean / null），无需构造 value 对象
 * - number 会按 32 位 INTEGER 绑定，毫秒时间戳会溢出，因此整数统一转 bigint 绑定
 * - BIGINT 读出为 BigInt，本模块统一转 number
 * - 不支持 INSERT OR REPLACE，改用 DELETE + INSERT
 * - 不支持 ON DELETE CASCADE，删除 files 时手动删 file_records
 * - 单进程单写者，同一 data.duckdb 只能被一个进程打开
 */
const { DuckDBInstance } = require('@duckdb/node-api');
const path = require('path');

const DB_PATH = process.env.DUCKDB_PATH || path.join(__dirname, '..', 'data.duckdb');

let db = null;
let conn = null;

function toNumber(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? Number(v) : v;
}

function normalizeFileRow(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: toNumber(row.created_at),
    expires_at: toNumber(row.expires_at),
  };
}

function normalizeRecordRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: toNumber(row.id),
    size: toNumber(row.size),
  };
}

/**
 * 绑定值归一化。
 *
 * node-api 1.2.2 按 JS 类型推断绑定类型：number 会按 INTEGER(32bit) 绑定，
 * Date.now() 这类毫秒时间戳会溢出（实测 1791642534858 -> 641172426）。
 * 因此所有整数统一转成 bigint，按 BIGINT(64bit) 绑定。
 */
function toBindValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return v;
}

function toBindValues(values) {
  return (values || []).map(toBindValue);
}

function getConn() {
  if (!conn) throw new Error('Database not initialized');
  return conn;
}

async function run(sql, params) {
  const stmt = await getConn().prepare(sql);
  try {
    if (params && params.length) stmt.bind(toBindValues(params));
    await stmt.run();
  } finally {
    stmt.destroySync();
  }
}

async function all(sql, params) {
  const stmt = await getConn().prepare(sql);
  try {
    if (params && params.length) stmt.bind(toBindValues(params));
    const reader = await stmt.runAndReadAll();
    return (await reader.getRowObjects()) || [];
  } finally {
    stmt.destroySync();
  }
}

async function get(sql, params) {
  const rows = await all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function initDb() {
  if (db) return db;

  db = await DuckDBInstance.create(DB_PATH);
  conn = await db.connect();

  await run('CREATE TABLE IF NOT EXISTS files (id VARCHAR PRIMARY KEY, folder_path VARCHAR NOT NULL, description VARCHAR, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, uploader_ip VARCHAR, uploader_ua VARCHAR, user_id VARCHAR)');
  await run('CREATE TABLE IF NOT EXISTS file_records (id BIGINT PRIMARY KEY, file_id VARCHAR NOT NULL, original_name VARCHAR NOT NULL, stored_name VARCHAR NOT NULL, size BIGINT, mime_type VARCHAR)');
  await run('CREATE TABLE IF NOT EXISTS settings (key VARCHAR PRIMARY KEY, value VARCHAR)');
  await run('CREATE SEQUENCE IF NOT EXISTS seq_file_records START 1');
  await run('CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at)');
  await run('CREATE INDEX IF NOT EXISTS idx_file_records_file_id ON file_records(file_id)');

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

async function closeDb() {
  try { if (conn && conn.closeSync) conn.closeSync(); } catch {}
  try { if (db && db.closeSync) db.closeSync(); } catch {}
  conn = null;
  db = null;
}

async function createFile({ id, folderPath, description, ip, ua, userId, expiresAt }) {
  await run(
    'INSERT INTO files (id, folder_path, description, created_at, expires_at, uploader_ip, uploader_ua, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, folderPath, description || '', Date.now(), expiresAt, ip || '', ua || '', userId || '']
  );
  return id;
}

async function addFileRecord({ fileId, originalName, storedName, size, mimeType }) {
  await run(
    "INSERT INTO file_records (id, file_id, original_name, stored_name, size, mime_type) VALUES (nextval('seq_file_records'), ?, ?, ?, ?, ?)",
    [fileId, originalName, storedName, size || 0, mimeType || '']
  );
}

async function getFileById(id) {
  const file = await get('SELECT * FROM files WHERE id = ?', [id]);
  if (!file) return null;
  const records = await all('SELECT * FROM file_records WHERE file_id = ?', [id]);
  return {
    ...normalizeFileRow(file),
    records: records.map(normalizeRecordRow),
  };
}

async function getFilesByUserId(userId) {
  const rows = await all('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [userId]);
  const result = [];
  for (const f of rows) {
    const records = await all('SELECT * FROM file_records WHERE file_id = ?', [f.id]);
    result.push({
      ...normalizeFileRow(f),
      records: records.map(normalizeRecordRow),
    });
  }
  return result;
}

async function validateFileIds(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(function () { return '?'; }).join(',');
  const rows = await all('SELECT id FROM files WHERE id IN (' + placeholders + ')', ids);
  return rows.map(function (r) { return r.id; });
}

async function deleteExpiredFiles(now) {
  const expired = await all('SELECT * FROM files WHERE expires_at < ?', [now]);
  for (const f of expired) {
    await run('DELETE FROM file_records WHERE file_id = ?', [f.id]);
    await run('DELETE FROM files WHERE id = ?', [f.id]);
  }
  return expired.map(normalizeFileRow);
}

async function getSetting(key) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await run('DELETE FROM settings WHERE key = ?', [key]);
  await run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

async function getAllSettings() {
  const rows = await all('SELECT * FROM settings');
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

async function getAllFileRecords() {
  const rows = await all('SELECT * FROM file_records');
  return rows.map(normalizeRecordRow);
}

async function deleteFileRecordById(id) {
  await run('DELETE FROM file_records WHERE id = ?', [id]);
}

async function getAllFiles() {
  const rows = await all('SELECT * FROM files');
  return rows.map(normalizeFileRow);
}

async function deleteFileById(id) {
  await run('DELETE FROM file_records WHERE file_id = ?', [id]);
  await run('DELETE FROM files WHERE id = ?', [id]);
}

async function getStats() {
  const fileCount = await get('SELECT COUNT(*) as count FROM files');
  const recordCount = await get('SELECT COUNT(*) as count FROM file_records');
  const totalSize = await get('SELECT SUM(size) as total FROM file_records');
  return {
    fileCount: toNumber(fileCount.count) || 0,
    fileRecordCount: toNumber(recordCount.count) || 0,
    totalSize: toNumber(totalSize.total) || 0,
  };
}

module.exports = {
  initDb,
  closeDb,
  getDb,
  createFile,
  addFileRecord,
  getFileById,
  getFilesByUserId,
  validateFileIds,
  deleteExpiredFiles,
  getAllFileRecords,
  deleteFileRecordById,
  getAllFiles,
  deleteFileById,
  getSetting,
  setSetting,
  getAllSettings,
  getStats,
};
