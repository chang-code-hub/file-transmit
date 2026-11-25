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

/**
 * 该记录是否为「外链跳转」条目：来自互联网链接且未托管，
 * 本地磁盘上没有实体文件，下载时应 302 回原始 URL。
 *
 * hosted 列对历史数据默认为 true（它们本来就有本地文件），
 * 因此判定以「有 source_url 且 hosted 不为真」为准。
 *
 * @param {object} row file_records 行
 * @returns {boolean}
 */
function isRedirectRecord(row) {
  if (!row || !row.source_url) return false;
  const h = row.hosted;
  return !(h === true || h === 1 || h === 'true');
}

/**
 * 确保 file_records 上有指定列。DuckDB 的 CREATE TABLE IF NOT EXISTS
 * 不会给已存在的表补列，升级时必须走 ALTER。
 *
 * @param {string} column 列名（小写比较）
 * @param {string} ddl    完整的 ALTER 语句
 */
async function ensureColumn(column, ddl) {
  const rows = await all('DESCRIBE file_records');
  const names = rows.map((r) => String(r.column_name || '').toLowerCase());
  if (!names.includes(column)) {
    await run(ddl);
  }
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

  // 互联网链接导入：source_url 记原始地址，hosted=false 表示只存跳转、不落地。
  // 旧库升级时补列；hosted 默认 true，历史记录都是有本地文件的。
  await ensureColumn('source_url', 'ALTER TABLE file_records ADD COLUMN source_url VARCHAR');
  await ensureColumn('hosted', 'ALTER TABLE file_records ADD COLUMN hosted BOOLEAN DEFAULT true');

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

/**
 * 新增一条文件记录。
 *
 * sourceUrl / hosted 用于互联网链接导入：
 *  - hosted=true  ：服务器已把远端文件下载到本地，sourceUrl 只作溯源
 *  - hosted=false ：本地没有实体文件，下载时按 sourceUrl 做 302 跳转
 *
 * @param {object} p
 * @param {boolean} [p.hosted] 默认 true（普通上传）
 */
async function addFileRecord({ fileId, originalName, storedName, size, mimeType, sourceUrl = '', hosted = true }) {
  await run(
    "INSERT INTO file_records (id, file_id, original_name, stored_name, size, mime_type, source_url, hosted) VALUES (nextval('seq_file_records'), ?, ?, ?, ?, ?, ?, ?)",
    [fileId, originalName, storedName, size || 0, mimeType || '', sourceUrl || '', hosted !== false]
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

/**
 * 列出文件（服务端调用方用，例如 Jenkins 按时间拉取待下载列表）。
 *
 * 与 getFilesByUserId 的区别：不按 cookie 用户过滤，且支持 since / 分页。
 *
 * @param {object} [opts]
 * @param {number} [opts.since]  只返回 createdAt >= since（毫秒）
 * @param {number} [opts.limit]  默认 50，上限 500
 * @param {number} [opts.offset] 默认 0
 * @returns {Promise<Array>} 与 getFileById 同结构（含 records）
 */
async function listFiles(opts = {}) {
  const since = Number(opts.since) > 0 ? Number(opts.since) : 0;
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const params = [];
  let where = '';
  if (since) {
    where = ' WHERE created_at >= ?';
    params.push(since);
  }
  const sql = 'SELECT * FROM files' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await all(sql, params);
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
  isRedirectRecord,
  getFileById,
  getFilesByUserId,
  listFiles,
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
