/**
 * 压缩文件检查服务 (Archive Inspection Service)
 *
 * 对上传的文件进行压缩包检测：
 * - 通过文件扩展名或魔数识别压缩文件类型
 * - 检测压缩文件是否加密（密码保护）
 * - 递归列出压缩包内文件
 *
 * 纯 Node.js 实现，无需外部依赖。使用 fs.openSync/readSync 进行字节级解析。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

// ============================================================
// 常量定义
// ============================================================

/** 常见压缩文件扩展名 */
const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso',
]);

/** 文件魔数签名表 */
const SIGNATURES = [
  { type: 'zip',  offset: 0,     bytes: [0x50, 0x4B, 0x03, 0x04] },
  { type: 'zip',  offset: 0,     bytes: [0x50, 0x4B, 0x05, 0x06] },
  { type: 'zip',  offset: 0,     bytes: [0x50, 0x4B, 0x07, 0x08] },
  { type: 'rar',  offset: 0,     bytes: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00] },
  { type: 'rar',  offset: 0,     bytes: [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00] },
  { type: '7z',   offset: 0,     bytes: [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] },
  { type: 'gz',   offset: 0,     bytes: [0x1F, 0x8B] },
  { type: 'bz2',  offset: 0,     bytes: [0x42, 0x5A, 0x68] },
  { type: 'xz',   offset: 0,     bytes: [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00] },
  { type: 'iso',  offset: 32769, bytes: [0x43, 0x44, 0x30, 0x30, 0x31] }, // "CD001"
];

/** 文件大小上限（超过此值跳过递归内容列挙） */
const SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5 GB

/** 压缩包内最大条目数（防止格式错误的文件导致无限循环） */
const MAX_ENTRIES = 100000;

/**
 * 递归统计目录中的文件数量（不含目录本身）
 * @param {string} dirPath
 * @returns {number}
 */
function countFilesRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countFilesRecursive(path.join(dirPath, entry.name));
      } else if (entry.isFile()) {
        count++;
      }
    }
  } catch (err) {
    logger.error(`[归档检查] 统计文件失败: ${dirPath} - ${err.message}`);
  }
  return count;
}

/**
 * 通过 7z l 命令获取压缩包内应有的文件列表（不含目录）
 * 在解压前调用，获取不受杀毒软件影响的权威文件清单
 * @param {string} sevenZipPath - 7z 可执行文件路径
 * @param {string} archivePath - 压缩包文件路径
 * @returns {{ files: string[], count: number }|null} 文件列表和数量，失败时返回 null
 */
function listFilesInArchive(sevenZipPath, archivePath) {
  try {
    const output = execSync(`"${sevenZipPath}" l -slt "${archivePath}"`, {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024,
    });

    const files = [];
    const lines = output.split('\n');
    let currentPath = '';
    let isFolder = false;

    // 构建压缩包自身路径的排除集合，防止将压缩包自身统计为内部文件
    // 7z 可能输出 basename 或完整路径，且分隔符可能是 \ 或 /
    const archiveSelfSet = new Set([
      path.basename(archivePath),
      archivePath,
      archivePath.replace(/\\/g, '/'),
    ]);

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('Path = ')) {
        // 保存上一个条目（跳过目录和压缩包自身路径）
        if (currentPath && !isFolder && !archiveSelfSet.has(currentPath)) {
          files.push(currentPath);
        }
        currentPath = trimmed.substring(7).trim();
        isFolder = false;
        continue;
      }

      if (trimmed.startsWith('Folder = ') && trimmed.includes('+')) {
        isFolder = true;
      }
      if (trimmed.startsWith('Attributes = ')) {
        const attrValue = trimmed.substring(13).trim();
        if (attrValue.startsWith('D')) {
          isFolder = true;
        }
      }
    }

    // 处理最后一个条目
    if (currentPath && !isFolder && !archiveSelfSet.has(currentPath)) {
      files.push(currentPath);
    }

    return { files, count: files.length };
  } catch (err) {
    logger.error(`[病毒检测] 7z 获取文件列表失败: ${err.message}`);
    return null;
  }
}

/**
 * 递归列挙目录中的文件路径（相对于 basePath）
 * @param {string} dirPath - 目录路径
 * @param {string} [basePath] - 基准路径（默认等于 dirPath）
 * @returns {string[]} 相对文件路径数组
 */
function listFilesRecursive(dirPath, basePath = dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...listFilesRecursive(fullPath, basePath));
      } else if (entry.isFile()) {
        files.push(path.relative(basePath, fullPath));
      }
    }
  } catch (err) {
    logger.error(`[归档检查] 列挙文件失败: ${dirPath} - ${err.message}`);
  }
  return files;
}

/**
 * 根据解压出的文件数量自动决定杀毒软件扫描等待时长
 * 文件越多，杀毒软件需要的时间越长
 * @param {number} fileCount - 解压出的文件数
 * @returns {number} 等待秒数
 */
function calcVirusDetectWait(fileCount) {
  if (fileCount <= 10)   return 10;
  if (fileCount <= 50)   return 20;
  if (fileCount <= 200)  return 30;
  if (fileCount <= 1000) return 45;
  return 60;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 从文件描述符读取指定偏移处的字节
 */
function readBytes(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

/**
 * 检查文件名是否具有压缩文件扩展名
 */
function isArchiveExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ARCHIVE_EXTENSIONS.has(ext);
}

/**
 * 根据扩展名获取压缩文件类型
 */
function getArchiveTypeByExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.zip': 'zip', '.rar': 'rar', '.7z': '7z', '.tar': 'tar',
    '.gz': 'gz', '.bz2': 'bz2', '.xz': 'xz', '.iso': 'iso',
  };
  return map[ext] || null;
}

/**
 * 比较缓冲区与字节数组
 */
function matchSignature(buffer, sig) {
  if (buffer.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buffer[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

// ============================================================
// 魔数检测
// ============================================================

/**
 * 通过文件魔数检测压缩文件类型
 * @param {string} filePath - 文件路径
 * @returns {string|null} 压缩文件类型或 null
 */
function detectArchiveType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');

    // 首先读取文件前 16 字节（覆盖大部分魔数偏移 0 的格式）
    let header = readBytes(fd, 0, 64);

    for (const sig of SIGNATURES) {
      if (sig.offset === 0 && matchSignature(header, sig)) {
        return sig.type;
      }
    }

    // 检查 ISO9660 签名（偏移 32769）
    if (header.length < 64) {
      // 如果第一次读取不够大，用更大的缓冲区
      header = readBytes(fd, 0, 32800);
    }
    for (const sig of SIGNATURES) {
      if (sig.offset > 0 && matchSignature(header, sig)) {
        return sig.type;
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// ============================================================
// ZIP 解析
// ============================================================

/**
 * 解析 ZIP 文件：检测加密并列出内容
 */
function checkZipArchive(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    let encrypted = false;

    // --- 扫描本地文件头 (Local File Header) 检测加密 ---
    // 签名: 50 4B 03 04, GP标志位在偏移 6 (2 bytes LE), bit 0 = 加密
    // 搜索范围：前 1 MB（大部分 ZIP 的文件头都在这里）
    const scanSize = Math.min(fileSize, 1024 * 1024);
    const scanBuf = readBytes(fd, 0, scanSize);
    const LFH_SIG = [0x50, 0x4B, 0x03, 0x04];

    let pos = 0;
    while (pos <= scanBuf.length - 30) {
      if (scanBuf[pos] === LFH_SIG[0] && scanBuf[pos+1] === LFH_SIG[1] &&
          scanBuf[pos+2] === LFH_SIG[2] && scanBuf[pos+3] === LFH_SIG[3]) {
        const gpFlag = scanBuf.readUInt16LE(pos + 6);
        if (gpFlag & 0x01) {
          encrypted = true;
          break;
        }
        // 跳过此条目
        const nameLen = scanBuf.readUInt16LE(pos + 26);
        const extraLen = scanBuf.readUInt16LE(pos + 28);
        pos += 30 + nameLen + extraLen;
      } else {
        pos++;
      }
    }

    // --- 解析中央目录 (Central Directory) 获取文件列表 ---
    // 在文件末尾搜索 EOCD 签名: 50 4B 05 06
    const contents = [];
    const eocdOffset = findZipEOCD(fd, fileSize);
    if (eocdOffset === -1) {
      return { encrypted, encryptionConfirmed: true, contents, warnings: [] };
    }

    const eocdBuf = readBytes(fd, eocdOffset, 22);
    if (eocdBuf.length < 22) {
      return { encrypted, encryptionConfirmed: true, contents, warnings: [] };
    }

    const cdOffset = eocdBuf.readUInt32LE(16);
    const cdSize = eocdBuf.readUInt32LE(12);
    const totalEntries = eocdBuf.readUInt16LE(10);

    // 检查是否为 ZIP64
    if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || totalEntries === 0xFFFF) {
      // 尝试读取 ZIP64 EOCD
      const zip64Result = readZip64Contents(fd, eocdOffset);
      if (zip64Result) return zip64Result;
      // ZIP64 解析失败则用已获取的信息
    }

    if (cdOffset + cdSize > fileSize || cdSize === 0) {
      return { encrypted, encryptionConfirmed: true, contents, warnings: [] };
    }

    // 读取中央目录
    const cdBuf = readBytes(fd, cdOffset, Math.min(cdSize, 100 * 1024 * 1024)); // 最多100MB
    parseCentralDirectory(cdBuf, contents, encrypted);

    return { encrypted, encryptionConfirmed: true, contents, warnings: [] };
  } catch {
    return { encrypted: false, encryptionConfirmed: true, contents: [], warnings: ['ZIP 解析失败，文件可能已损坏'] };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * 在 ZIP 文件末尾搜索 EOCD 签名
 */
function findZipEOCD(fd, fileSize) {
  const searchSize = Math.min(fileSize, 65535 + 22); // EOCD 最大偏移 + 自身大小
  const searchBuf = readBytes(fd, fileSize - searchSize, searchSize);
  const EOCD_SIG = [0x50, 0x4B, 0x05, 0x06];

  for (let i = searchBuf.length - 22; i >= 0; i--) {
    if (searchBuf[i] === EOCD_SIG[0] && searchBuf[i+1] === EOCD_SIG[1] &&
        searchBuf[i+2] === EOCD_SIG[2] && searchBuf[i+3] === EOCD_SIG[3]) {
      return fileSize - searchSize + i;
    }
  }
  return -1;
}

/**
 * 尝试读取 ZIP64 EOCD
 */
function readZip64Contents(fd, eocdOffset) {
  try {
    // ZIP64 EOCD Locator 在标准 EOCD 之前 20 字节
    if (eocdOffset < 20) return null;
    const locBuf = readBytes(fd, eocdOffset - 20, 20);
    if (locBuf[0] !== 0x50 || locBuf[1] !== 0x4B || locBuf[2] !== 0x06 || locBuf[3] !== 0x07) {
      return null; // 不是 ZIP64 Locator
    }
    const zip64EocdOffset = Number(locBuf.readBigUInt64LE(8));
    const zip64EocdBuf = readBytes(fd, zip64EocdOffset, 56);
    if (zip64EocdBuf[0] !== 0x50 || zip64EocdBuf[1] !== 0x4B ||
        zip64EocdBuf[2] !== 0x06 || zip64EocdBuf[3] !== 0x06) {
      return null;
    }
    const cdOffset = Number(zip64EocdBuf.readBigUInt64LE(48));
    const cdSize = Number(zip64EocdBuf.readBigUInt64LE(40));
    const cdBuf = readBytes(fd, cdOffset, Math.min(cdSize, 100 * 1024 * 1024));
    const contents = [];
    let encrypted = false;
    parseCentralDirectory(cdBuf, contents, encrypted);
    return { encrypted, encryptionConfirmed: true, contents, warnings: [] };
  } catch {
    return null;
  }
}

/**
 * 解析中央目录缓冲区提取文件名
 */
function parseCentralDirectory(cdBuf, contents, encryptedRef) {
  const CD_SIG = [0x50, 0x4B, 0x01, 0x02];
  let pos = 0;
  let entryCount = 0;

  while (pos <= cdBuf.length - 46 && entryCount < MAX_ENTRIES) {
    if (cdBuf[pos] === CD_SIG[0] && cdBuf[pos+1] === CD_SIG[1] &&
        cdBuf[pos+2] === CD_SIG[2] && cdBuf[pos+3] === CD_SIG[3]) {
      const gpFlag = cdBuf.readUInt16LE(pos + 8);
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);

      if (pos + 46 + nameLen <= cdBuf.length) {
        const filename = cdBuf.toString('utf-8', pos + 46, pos + 46 + nameLen);
        const isDir = filename.endsWith('/') || filename.endsWith('\\');
        const isArchive = isArchiveExtension(filename);

        contents.push({
          path: filename,
          isDirectory: isDir,
          isArchive,
          archiveType: isArchive ? getArchiveTypeByExtension(filename) : null,
        });

        if (!encryptedRef && (gpFlag & 0x01)) {
          encryptedRef = true;
        }
        entryCount++;
      }

      pos += 46 + nameLen + extraLen + commentLen;
    } else {
      pos++;
    }
  }
}

// ============================================================
// RAR4 解析
// ============================================================

/**
 * 解析 RAR4 文件：检测加密并列出内容
 *
 * RAR4 结构:
 *   7 bytes: 签名 "Rar!\x1A\x07\x00"
 *   后续为块序列，每块:
 *     2 bytes: HEAD_CRC
 *     1 byte:  HEAD_TYPE
 *     2 bytes: HEAD_FLAGS (bit 7 = 加密)
 *     2 bytes: HEAD_SIZE
 *     [可变数据]
 *
 * HEAD_TYPE:
 *   0x72 - 标记块 (Marker block)
 *   0x73 - 归档头 (Archive header)
 *   0x74 - 文件头 (File header)
 */
function checkRar4Archive(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    let encrypted = false;
    const contents = [];
    const warnings = [];

    // 跳过 7 字节签名
    let pos = 7;
    let entryCount = 0;
    const maxPos = Math.min(fileSize, 10 * 1024 * 1024); // 扫描前 10 MB

    while (pos + 7 <= maxPos && entryCount < MAX_ENTRIES) {
      const blockHeader = readBytes(fd, pos, 7);
      if (blockHeader.length < 7) break;

      // const headCrc = blockHeader.readUInt16LE(0);
      const headType = blockHeader[2];
      const headFlags = blockHeader.readUInt16LE(3);
      const headSize = blockHeader.readUInt16LE(5);

      if (headSize < 7) break; // 无效块
      if (pos + headSize > maxPos) break;

      // 检查加密标志 (bit 7)
      if (headFlags & 0x0080) {
        encrypted = true;
      }

      // 文件头 (0x74): 提取文件名
      if (headType === 0x74 && headSize >= 25) {
        const fileHeader = readBytes(fd, pos + 7, headSize - 7);
        // 文件头数据: 压缩大小(4) + 未压缩大小(4) + 主机OS(1) + 文件CRC(4)
        // + 文件时间(4) + 解压版本(1) + 压缩方法(1) + 文件名长度(2) + 文件属性(4)
        if (fileHeader.length >= 20) {
          const nameLen = fileHeader.readUInt16LE(18);
          // 高字节可能包含标志，取低字节
          const actualNameLen = nameLen & 0xFF;
          if (actualNameLen > 0 && 20 + actualNameLen <= fileHeader.length) {
            const filename = fileHeader.toString('utf-8', 20, 20 + actualNameLen);
            const isDir = filename.endsWith('/') || filename.endsWith('\\');
            const isArchive = isArchiveExtension(filename);

            contents.push({
              path: filename,
              isDirectory: isDir,
              isArchive,
              archiveType: isArchive ? getArchiveTypeByExtension(filename) : null,
            });
            entryCount++;
          }
        }
      }

      pos += headSize;
    }

    return { encrypted, encryptionConfirmed: true, contents, warnings };
  } catch {
    return { encrypted: false, encryptionConfirmed: true, contents: [], warnings: ['RAR 解析失败，文件可能已损坏'] };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// ============================================================
// RAR5 解析
// ============================================================

/**
 * 读取 RAR5 风格的变长整数 (LEB128 variant)
 * RAR5 使用 7-bit 变长编码，与标准 varint 类似
 * 返回 { value, bytesRead }
 */
function readRar5Varint(fd, offset) {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  // 单字节读取（每个字节最多需要一次 seek）
  for (let i = 0; i < 10; i++) {
    const b = readBytes(fd, offset + i, 1);
    if (b.length === 0) break;
    bytesRead++;
    value |= (b[0] & 0x7F) << shift;
    if ((b[0] & 0x80) === 0) break;
    shift += 7;
  }

  return { value, bytesRead };
}

/**
 * 解析 RAR5 文件：检测加密并列出内容
 *
 * RAR5 结构:
 *   8 bytes: 签名 "Rar!\x1A\x07\x01\x00"
 *   4 bytes: Header CRC32
 *   变长整数: Header size
 *   变长整数: Header type (1=main archive, 2=file, 3=service)
 *   变长整数: Header flags
 *     bit 8 (0x100): FILE_ENCRYPTED / SERVICE_ENCRYPTED
 *   ...
 *   变长整数: Extra area size
 *   变长整数: Data area size
 */
function checkRar5Archive(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    let encrypted = false;
    const contents = [];
    const warnings = [];

    let pos = 8; // 跳过 8 字节签名

    // 跳过第一个块（主归档头）的 header CRC
    pos += 4;

    let entryCount = 0;
    const maxPos = Math.min(fileSize, 10 * 1024 * 1024);

    while (pos < maxPos && entryCount < MAX_ENTRIES) {
      // 读取 header size
      const sizeResult = readRar5Varint(fd, pos);
      if (sizeResult.bytesRead === 0 || sizeResult.value === 0) break;
      const headerSize = sizeResult.value;
      pos += sizeResult.bytesRead;

      // 读取 header type
      const typeResult = readRar5Varint(fd, pos);
      if (typeResult.bytesRead === 0) break;
      const headerType = typeResult.value;
      pos += typeResult.bytesRead;

      // 读取 header flags
      const flagsResult = readRar5Varint(fd, pos);
      if (flagsResult.bytesRead === 0) break;
      const headerFlags = flagsResult.value;
      pos += flagsResult.bytesRead;

      // 检查加密标志 (bit 8 = 0x100)
      if ((headerType === 2 || headerType === 3) && (headerFlags & 0x100)) {
        encrypted = true;
      }

      // 读取 extra area size
      const extraResult = readRar5Varint(fd, pos);
      if (extraResult.bytesRead === 0) break;
      const extraSize = extraResult.value;
      pos += extraResult.bytesRead;

      // 读取 data area size
      const dataResult = readRar5Varint(fd, pos);
      if (dataResult.bytesRead === 0) break;
      const dataSize = dataResult.value;
      pos += dataResult.bytesRead;

      // 文件头 (type 2): 提取文件名
      if (headerType === 2 && dataSize > 0) {
        // 文件头数据: flags(4) + unpSize(varint) + attributes(varint) + mtime(4) + CRC32(4)
        // + compInfo(varint) + hostOS(varint) + nameLen(varint) + name
        const dataStart = pos;

        // 跳过 flags (4 bytes)
        let dp = dataStart + 4;

        // 跳过 unpSize (varint)
        const unpResult = readRar5Varint(fd, dp);
        if (unpResult.bytesRead === 0) break;
        dp += unpResult.bytesRead;

        // 跳过 attributes (varint)
        const attrResult = readRar5Varint(fd, dp);
        if (attrResult.bytesRead === 0) break;
        dp += attrResult.bytesRead;

        // 跳过 mtime (4 bytes, only if flag set)
        const mtimeFlag = readBytes(fd, dataStart, 4).readUInt32LE(0);
        if (mtimeFlag & 0x0002) {
          dp += 4; // mtime is present
        }

        // 跳过 CRC32 (4 bytes, only if flag set)
        if (mtimeFlag & 0x0008) {
          dp += 4;
        }

        // 跳过 compInfo (varint)
        const compResult = readRar5Varint(fd, dp);
        if (compResult.bytesRead === 0) break;
        dp += compResult.bytesRead;

        // 跳过 hostOS (varint)
        const hostResult = readRar5Varint(fd, dp);
        if (hostResult.bytesRead === 0) break;
        dp += hostResult.bytesRead;

        // 读取 nameLen (varint)
        const nameLenResult = readRar5Varint(fd, dp);
        if (nameLenResult.bytesRead === 0) break;
        dp += nameLenResult.bytesRead;

        const nameLen = nameLenResult.value;
        if (nameLen > 0 && nameLen <= 4096 && dp + nameLen <= dataStart + dataSize) {
          const nameBuf = readBytes(fd, dp, nameLen);
          const filename = nameBuf.toString('utf-8');
          const isDir = filename.endsWith('/') || filename.endsWith('\\');
          const isArchive = isArchiveExtension(filename);

          contents.push({
            path: filename,
            isDirectory: isDir,
            isArchive,
            archiveType: isArchive ? getArchiveTypeByExtension(filename) : null,
          });
          entryCount++;
        }
      }

      // 跳过数据区 + extra 区
      pos += dataSize + extraSize;
    }

    return { encrypted, encryptionConfirmed: true, contents, warnings };
  } catch {
    return { encrypted: false, encryptionConfirmed: true, contents: [], warnings: ['RAR5 解析失败，文件可能已损坏'] };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// ============================================================
// 7z 检测（启发式）
// ============================================================

/**
 * 7z 加密检测（启发式）
 *
 * 7z 文件头使用 LZMA 压缩，纯 JS 无法完整解析。
 * 通过搜索 7zAES 方法 ID (06 F1 07 01) 来启发式检测 AES 加密。
 * 此方法可能产生假阴性（无法保证 100% 检出加密）。
 */
function check7zArchive(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    let encrypted = false;
    const warnings = ['7z 加密检测为启发式方法，可能存在漏报'];

    // 验证 7z 签名
    const sigBuf = readBytes(fd, 0, 6);
    if (sigBuf[0] !== 0x37 || sigBuf[1] !== 0x7A || sigBuf[2] !== 0xBC ||
        sigBuf[3] !== 0xAF || sigBuf[4] !== 0x27 || sigBuf[5] !== 0x1C) {
      return { encrypted: false, encryptionConfirmed: false, contents: [], warnings };
    }

    // 扫描文件内容查找 7zAES 方法 ID
    // 7zAES 编码器 ID: 06 F1 07 01 (AES-256 + SHA-256)
    const AES_MARKER = [0x06, 0xF1, 0x07, 0x01];
    const scanSize = Math.min(fileSize, 512 * 1024); // 扫描前 512 KB

    let offset = 32; // 跳过基本头部
    while (offset + 4 <= scanSize) {
      const chunk = readBytes(fd, offset, Math.min(65536, scanSize - offset));
      for (let i = 0; i <= chunk.length - 4; i++) {
        if (chunk[i] === AES_MARKER[0] && chunk[i+1] === AES_MARKER[1] &&
            chunk[i+2] === AES_MARKER[2] && chunk[i+3] === AES_MARKER[3]) {
          encrypted = true;
          break;
        }
      }
      if (encrypted) break;
      offset += chunk.length;
    }

    return { encrypted, encryptionConfirmed: false, contents: [], warnings };
  } catch {
    return { encrypted: false, encryptionConfirmed: false, contents: [], warnings: ['7z 解析失败'] };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// ============================================================
// 简单格式（tar / gz / bz2 / xz / iso）
// ============================================================

/**
 * 处理不原生支持加密的压缩格式
 * tar 可以列挙文件名，gz/bz2/xz/iso 仅返回基本信息
 */
function checkSimpleArchive(filePath, archiveType) {
  const warnings = [];
  let contents = [];

  // tar 可以列出文件名
  if (archiveType === 'tar') {
    try {
      contents = listTarContents(filePath);
    } catch {
      warnings.push('tar 文件解析失败');
    }
  }

  // gz/bz2/xz/iso — 不支持加密也不支持内容列挙
  if (['gz', 'bz2', 'xz', 'iso'].includes(archiveType)) {
    // gz 可以尝试读取原始文件名（存储在头部）
    if (archiveType === 'gz') {
      try {
        const gzName = readGzipOriginalName(filePath);
        if (gzName) {
          const isArchive = isArchiveExtension(gzName);
          contents.push({
            path: gzName,
            isDirectory: false,
            isArchive,
            archiveType: isArchive ? getArchiveTypeByExtension(gzName) : null,
          });
        }
      } catch {}
    }
  }

  // 这些格式不原生支持加密
  return { encrypted: false, encryptionConfirmed: true, contents, warnings };
}

/**
 * 列出 tar 文件中的文件名
 * tar 每 512 字节一个头部块，文件名在偏移 0 处，最长 100 字节
 */
function listTarContents(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const contents = [];
    let pos = 0;
    let entryCount = 0;

    while (pos + 512 <= stat.size && entryCount < MAX_ENTRIES) {
      const header = readBytes(fd, pos, 512);
      if (header.length < 512) break;

      // 检查是否为空块（全零表示 tar 结束）
      let allZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) { allZero = false; break; }
      }
      if (allZero) break;

      // 读取文件名（偏移 0，最多 100 字节）
      let nameEnd = 0;
      while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
      const filename = header.toString('utf-8', 0, nameEnd);

      if (filename.length > 0 && filename !== './' && filename !== '.') {
        // POSIX tar: typeflag 在偏移 156，"5"=目录，"0"或"\0"=普通文件
        const typeflag = header[156];
        const isDir = typeflag === 0x35; // '5' = directory

        // GNU tar long name: typeflag 'L' 或 'K'，后一个块包含长文件名
        // 简化处理：跳过特殊类型
        if (typeflag === 0x4C || typeflag === 0x4B) { // 'L' or 'K'
          // 读取 long name 数据
          // 实际生产代码可以解析长文件名，这里简化跳过
          const sizeStr = header.toString('utf-8', 124, 136).replace(/\0/g, '').trim();
          const dataSize = parseInt(sizeStr, 8) || 0;
          const blocks = Math.ceil(dataSize / 512);
          pos += 512 + blocks * 512;
          continue;
        }

        const isArchive = isArchiveExtension(filename);
        contents.push({
          path: filename,
          isDirectory: isDir,
          isArchive,
          archiveType: isArchive ? getArchiveTypeByExtension(filename) : null,
        });
        entryCount++;
      } else if (filename.length === 0 && entryCount > 0) {
        // 空文件名在 tar 中是填充块
      }

      // 计算下一个块位置
      // 文件大小在偏移 124，12 字节八进制
      if (filename.length > 0 || entryCount > 0) {
        const sizeStr = header.toString('utf-8', 124, 136).replace(/\0/g, '').trim();
        const fileSize = parseInt(sizeStr, 8) || 0;
        const blocks = Math.ceil(fileSize / 512);
        pos += 512 + blocks * 512;
      } else {
        pos += 512;
      }
    }

    return contents;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * 读取 gzip 原始文件名（存储在头部偏移 10 之后）
 */
function readGzipOriginalName(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    // gzip 头部: 1F 8B 08 [flags] [mtime 4] [extra flags] [OS]
    const header = readBytes(fd, 0, 10);
    if (header.length < 10) return null;
    if (header[0] !== 0x1F || header[1] !== 0x8B) return null;

    const flags = header[3];
    let offset = 10;

    // 跳过 extra field
    if (flags & 0x04) {
      const extraLen = readBytes(fd, offset, 2);
      offset += 2 + extraLen.readUInt16LE(0);
    }

    // 读取原始文件名（以 null 结尾的字符串）
    if (flags & 0x08) {
      let name = '';
      while (offset < 4096) {
        const b = readBytes(fd, offset, 1);
        offset++;
        if (b.length === 0 || b[0] === 0) break;
        name += String.fromCharCode(b[0]);
      }
      return name || null;
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// ============================================================
// 7z 主检测（优先于纯 JS 解析）
// ============================================================

/**
 * 使用 7z 进行压缩包检测：内容列挙 + 加密检测 + 解压测试
 *
 * 相比纯 JS 解析，7z 支持更多格式且更可靠。
 * - 7z l -slt: 列挙内容 + 加密状态检测（无需密码）
 * - 7z t -p"": 解压缩完整性测试（空密码，加密文件会报错从而确认加密）
 *
 * @param {string} sevenZipPath - 7z 可执行文件路径
 * @param {string} filePath - 压缩包文件路径
 * @returns {object|null} 检测结果，失败时返回 null（调用方应回退到纯 JS 解析）
 */
function checkArchiveWith7z(sevenZipPath, filePath) {
  const warnings = [];
  let encrypted = false;
  const contents = [];
  let decompressionTested = false;
  let decompressionPassed = false;

  // 1. 使用 7z l -slt 列挙文件内容和加密状态
  let listOutput;
  try {
    listOutput = execSync(`"${sevenZipPath}" l -slt "${filePath}"`, {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const errMsg = (err.stderr || err.stdout || err.message || '').toString();
    // 部分加密文件在列挙时也会报密码错误
    if (errMsg.includes('Wrong password') || errMsg.includes('Cannot open encrypted')) {
      return {
        encrypted: true,
        encryptionConfirmed: true,
        contents: [],
        warnings: ['7z 列挙失败，文件已加密保护'],
        decompressionTested: false,
        decompressionPassed: false,
      };
    }
    // 7z 无法处理此文件
    return null;
  }

  // 按 "Path = " 行分割文件条目
  // 7z l -slt 输出格式：
  //   --                     (archive header)
  //   Path = archive.zip
  //   Type = zip
  //   ----------             (header/file separator, only once)
  //   Path = file1.txt       (file 1 begins)
  //   ...
  //   [blank line]
  //   Path = file2.txt       (file 2 begins)
  //   ...
  // 文件之间由空行分隔，但更可靠的方式是按 "Path = " 行检测每个条目的开始
  {
    const lines = listOutput.split('\n');
    let currentPath = '';
    let isEncrypted = false;
    let isFolder = false;
    let inFileEntry = false; // 是否已进入文件列表区域

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 检测文件列表区域的开始（archive header 以 "--" 开头，后跟 "Path = <archive_path>"）
      if (!inFileEntry && line.startsWith('Path = ') && i > 0) {
        // 检查前一行是否为 "--"
        const prevLine = lines[i - 1].trim();
        if (prevLine === '--' || prevLine.startsWith('Path = ')) {
          // 这是 archive 自己的路径，跳过（或已进入列表区域）
        }
      }

      // 遇到 "Path = " 开始一个新条目
      if (line.startsWith('Path = ')) {
        // 保存上一个条目
        if (currentPath && currentPath !== filePath) {
          const isArchive = isArchiveExtension(currentPath);
          contents.push({
            path: currentPath,
            isDirectory: isFolder || currentPath.endsWith('/') || currentPath.endsWith('\\'),
            isArchive,
            archiveType: isArchive ? getArchiveTypeByExtension(currentPath) : null,
          });
          if (isEncrypted) encrypted = true;
        }

        // 开始新条目
        currentPath = line.substring(7).trim();
        isEncrypted = false;
        isFolder = false;
        inFileEntry = true;
        continue;
      }

      if (!inFileEntry) continue;

      if (line.startsWith('Encrypted = ')) {
        isEncrypted = line.includes('+');
      }
      if (line.startsWith('Folder = ')) {
        isFolder = line.includes('+');
      }
      if (line.startsWith('Attributes = ')) {
        const attrValue = line.substring(13).trim();
        if (attrValue.startsWith('D')) {
          isFolder = true;
        }
      }
    }

    // 保存最后一个条目
    if (currentPath && currentPath !== filePath) {
      const isArchive = isArchiveExtension(currentPath);
      contents.push({
        path: currentPath,
        isDirectory: isFolder || currentPath.endsWith('/') || currentPath.endsWith('\\'),
        isArchive,
        archiveType: isArchive ? getArchiveTypeByExtension(currentPath) : null,
      });
      if (isEncrypted) encrypted = true;
    }
  }

  // 2. 使用 7z t -p"" 进行解压缩测试
  if (!encrypted) {
    try {
      execSync(`"${sevenZipPath}" t -p"" "${filePath}"`, {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      decompressionPassed = true;
    } catch (err) {
      const stdErr = (err.stderr || '').toString();
      const stdOut = (err.stdout || '').toString();
      const combined = stdErr + stdOut;

      if (combined.includes('Wrong password') || combined.includes('Cannot open encrypted')) {
        // 空密码测试失败说明确实是加密的
        encrypted = true;
        warnings.push('解压测试确认文件已加密');
      } else {
        warnings.push(`解压测试未通过: ${(stdErr || stdOut).substring(0, 200)}`);
      }
    }
    decompressionTested = true;
  } else {
    warnings.push('文件已加密，跳过解压测试');
  }

  return {
    encrypted,
    encryptionConfirmed: true,
    contents,
    warnings,
    decompressionTested,
    decompressionPassed,
  };
}

// ============================================================
// 递归检测
// ============================================================

/**
 * 对压缩包内文件进行递归检测
 * - 若配置了 sevenZipPath，通过 7z 解压嵌套压缩包进行实际检测
 * - 否则仅通过文件名后缀判断
 *
 * @param {Array} contents - 压缩包内文件列表
 * @param {object} config - 检测配置
 * @param {string} archivePath - 外层压缩包文件路径（供 7z 使用）
 * @returns {Array} 递归检测结果
 */
function recursiveInspect(contents, config, archivePath) {
  const { sevenZipPath } = config;
  const findings = [];

  for (const entry of contents) {
    if (!entry.isArchive) continue;

    if (sevenZipPath && archivePath) {
      // 使用 7z 解压嵌套压缩包进行实际检测
      try {
        const result = inspectNestedArchiveWith7z(sevenZipPath, archivePath, entry.path);
        findings.push(result);
      } catch (err) {
        findings.push({
          path: entry.path,
          isArchive: true,
          archiveType: entry.archiveType,
          isEncrypted: false,
          encryptionConfirmed: false,
          onlyByName: false,
          note: `7z 检查失败: ${err.message}`,
        });
      }
    } else {
      // 未配置 7z 路径，仅通过文件名后缀判断
      findings.push({
        path: entry.path,
        isArchive: true,
        archiveType: entry.archiveType,
        isEncrypted: false,
        encryptionConfirmed: false,
        onlyByName: true,
        note: '压缩包内文件仅通过文件名后缀判断，未解压检测内容',
      });
    }
  }

  return findings;
}

/**
 * 使用 7z 检查嵌套压缩包
 * 通过 7z l -slt 列出嵌套压缩包内容，检测加密状态
 *
 * @param {string} sevenZipPath - 7z 可执行文件路径
 * @param {string} archivePath - 外层压缩包路径
 * @param {string} nestedPath - 嵌套压缩包在外层中的路径
 * @returns {object} 检测结果
 */
function inspectNestedArchiveWith7z(sevenZipPath, archivePath, nestedPath) {
  const cmd = `"${sevenZipPath}" l -slt "${archivePath}" "${nestedPath}"`;
  let output;
  try {
    output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`7z 执行失败: ${err.message}`);
  }

  const nestedContents = [];
  let encrypted = false;

  // 按 "----------" 分割每个文件条目
  const entries = output.split(/^-{5,}$/m);

  for (const entryBlock of entries) {
    const lines = entryBlock.split('\n').map(l => l.trim());
    let currentPath = '';
    let isEncrypted = false;
    let isFolder = false;

    for (const line of lines) {
      if (line.startsWith('Path = ')) {
        currentPath = line.substring(7).trim();
      }
      if (line.startsWith('Encrypted = ')) {
        isEncrypted = line.includes('+');
      }
      if (line.startsWith('Folder = ')) {
        isFolder = line.includes('+');
      }
      if (line.startsWith('Attributes = ')) {
        // 目录属性以 'D' 开头
        if (line.includes('D') && line.charAt(13) === 'D') {
          isFolder = true;
        }
      }
    }

    if (currentPath && currentPath !== nestedPath) {
      const isArchive = isArchiveExtension(currentPath);

      nestedContents.push({
        path: currentPath,
        isDirectory: isFolder || currentPath.endsWith('/') || currentPath.endsWith('\\'),
        isArchive,
        archiveType: isArchive ? getArchiveTypeByExtension(currentPath) : null,
      });

      if (isEncrypted) encrypted = true;
    }
  }

  return {
    path: nestedPath,
    isArchive: true,
    archiveType: getArchiveTypeByExtension(nestedPath),
    isEncrypted: encrypted,
    encryptionConfirmed: true,
    onlyByName: false,
    contents: nestedContents,
  };
}

// ============================================================
// 7z 解压递归检测
// ============================================================

/**
 * 使用 7z 解压压缩包到临时目录，递归检查解压出的文件
 *
 * 当开启递归检测且配置了 7z 时，不再仅通过文件名后缀判断嵌套压缩包，
 * 而是实际解压出来，对所有解压出的文件进行完整的压缩包检测。
 *
 * 在顶层调用时（depth=0），如果启用了病毒检测（enableVirusDetect），
 * 会在解压完成后等待一定时间，然后对比文件数量来判断杀毒软件是否删除了可疑文件。
 *
 * @param {string} sevenZipPath - 7z 可执行文件路径
 * @param {string} archivePath - 压缩包文件路径
 * @param {object} config - 检测配置（传入 inspectArchives）
 * @returns {Promise<Array>} 递归检测结果（仅包含压缩包文件的结果）
 */
async function extractAndRecheck(sevenZipPath, archivePath, config, depth = 0) {
  const MAX_RECURSION_DEPTH = 5;

  if (depth >= MAX_RECURSION_DEPTH) {
    return [{ note: `递归深度已达上限 (${MAX_RECURSION_DEPTH})，跳过解压检测`, skipped: true }];
  }

  const findings = [];
  const tempDir = archivePath + '.extracted';

  try {
    // 检查文件大小，超过上限则跳过
    const stat = fs.statSync(archivePath);
    if (stat.size > SIZE_LIMIT) {
      return [{
        note: `压缩包超过 5GB，跳过递归解压检测`,
        skipped: true,
      }];
    }

    // 创建临时解压目录
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 使用 7z x 解压到临时目录
    try {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      logger.log(`[归档检测] 开始解压: ${path.basename(archivePath)} (${sizeMB} MB) → 临时目录`);

      const extractOutput = execSync(`"${sevenZipPath}" x -o"${tempDir}" -y "${archivePath}"`, {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });

      // 输出 7z 解压摘要（最后几行包含文件数量、大小等统计信息）
      const lines = extractOutput.trim().split('\n');
      const summary = lines.slice(-5).filter(l => l.trim()).join('; ');
      const extractedCount = countFilesRecursive(tempDir);
      logger.log(`[归档检测] 解压完成: ${extractedCount} 个文件, ${summary}`);
    } catch (err) {
      const errMsg = (err.stderr || err.stdout || err.message || '').toString();
      const errLines = errMsg.trim().split('\n');
      const errSummary = errLines.slice(-3).filter(l => l.trim()).join('; ');
      logger.error(`[归档检测] 解压失败: ${path.basename(archivePath)} - ${errSummary}`);
      return [{
        note: `解压失败: ${errMsg.substring(0, 200)}`,
        skipped: true,
      }];
    }

    // 对解压出的所有文件进行递归检测
    const subConfig = { ...config, _depth: depth + 1 };
    const subResult = await inspectArchives(tempDir, subConfig);

    // 收集发现的压缩文件（标记为递归发现）
    for (const f of subResult.files) {
      if (f.isArchive) {
        f.recursiveDepth = depth + 1;
        f.recursiveSource = path.basename(archivePath);
        findings.push(f);
      }
    }

    // 如果子检测也阻止了（有加密文件），向上传递
    if (subResult.blocked) {
      findings._blocked = true;
      findings._blockReasons = subResult.blockReasons;
    }

    // 传递子检测的病毒检测结果
    if (subResult.virusDetected) {
      findings._virusDetected = true;
      findings._virusMissing = subResult.virusMissing;
      findings._virusMissingFiles = subResult.virusMissingFiles || [];
      findings._virusBeforeCount = subResult.virusBeforeCount;
      findings._virusAfterCount = subResult.virusAfterCount;
    }

    // --- 病毒检测（7z 预期文件列表 vs 解压后实际文件列表）---
    // 对每一层解压都执行病毒检测（depth >= 0），确保嵌套压缩包内的文件也被扫描
    // 解压前通过 7z l 获取压缩包内应有的文件列表，解压后与实际文件系统对比
    // 若文件缺失，说明杀毒软件删除了可疑文件
    if (config.enableVirusDetect) {
      const archiveFileList = listFilesInArchive(sevenZipPath, archivePath);

      if (archiveFileList && archiveFileList.count > 0) {
        const actualFiles = listFilesRecursive(tempDir);
        const expectedSet = new Set(archiveFileList.files);
        const actualSet = new Set(actualFiles);

        // 找出缺失的文件（在预期列表中但不在实际文件系统中）
        const missingFiles = archiveFileList.files.filter(f => !actualSet.has(f));

        // 找出多出的文件（在实际文件系统中但不在预期列表中，可能为解压产生的临时文件）
        const extraFiles = actualFiles.filter(f => !expectedSet.has(f));

        if (missingFiles.length > 0) {
          const maxShow = 20;
          const showFiles = missingFiles.slice(0, maxShow);
          const fileList = showFiles.map(f => `  - ${f}`).join('\n');
          const suffix = missingFiles.length > maxShow
            ? `\n  ... 及其他 ${missingFiles.length - maxShow} 个文件`
            : '';

          const depthTag = depth > 0 ? `[深度${depth}] ` : '';
          logger.log(`[病毒检测] ${depthTag}⚠️ 发现 ${missingFiles.length} 个文件缺失，疑似被杀毒软件删除：\n${fileList}${suffix}`);
          findings._virusDetected = true;
          findings._virusMissing = missingFiles.length;
          findings._virusMissingFiles = missingFiles;
          findings._virusBeforeCount = archiveFileList.count;
          findings._virusAfterCount = actualFiles.length;
        } else {
          const depthTag = depth > 0 ? `[深度${depth}] ` : '';
          logger.log(`[病毒检测] ${depthTag}✅ 文件列表一致 (共 ${actualFiles.length} 个文件)，未发现异常`);
        }

        // 多出文件仅记录日志，不视为病毒
        if (extraFiles.length > 0) {
          const depthTag = depth > 0 ? `[深度${depth}] ` : '';
          logger.log(`[病毒检测] ${depthTag}ℹ️ 解压后多出 ${extraFiles.length} 个文件（可能为符号链接或临时文件），已忽略`);
        }
      } else if (!archiveFileList) {
        // 7z 列表获取失败，回退到等待对比模式
        const depthTag = depth > 0 ? `[深度${depth}] ` : '';
        logger.log(`[病毒检测] ${depthTag}7z 获取文件列表失败，回退到等待对比模式`);
        const beforeCount = countFilesRecursive(tempDir);
        if (beforeCount > 0) {
          const waitSeconds = calcVirusDetectWait(beforeCount);
          logger.log(`[病毒检测] ${depthTag}解压后共 ${beforeCount} 个文件，等待 ${waitSeconds} 秒以便杀毒软件扫描...`);
          await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));

          const beforeFiles = listFilesRecursive(tempDir);
          const afterFiles = listFilesRecursive(tempDir);
          const afterSet = new Set(afterFiles);
          const missingFiles = beforeFiles.filter(f => !afterSet.has(f));

          if (missingFiles.length > 0) {
            const maxShow = 20;
            const showFiles = missingFiles.slice(0, maxShow);
            const fileList = showFiles.map(f => `  - ${f}`).join('\n');
            const suffix = missingFiles.length > maxShow
              ? `\n  ... 及其他 ${missingFiles.length - maxShow} 个文件`
              : '';

            logger.log(`[病毒检测] ${depthTag}⚠️ 文件数量减少！${beforeFiles.length} → ${afterFiles.length}，减少 ${missingFiles.length} 个文件：\n${fileList}${suffix}`);
            findings._virusDetected = true;
            findings._virusMissing = missingFiles.length;
            findings._virusMissingFiles = missingFiles;
            findings._virusBeforeCount = beforeFiles.length;
            findings._virusAfterCount = afterFiles.length;
          } else {
            logger.log(`[病毒检测] ${depthTag}✅ 文件数量一致 (${beforeFiles.length})，未发现异常`);
          }
        }
      } else {
        // archiveFileList.count === 0，压缩包内无文件
        logger.log(`[病毒检测] ${depth > 0 ? `[深度${depth}] ` : ''}压缩包内无文件，跳过病毒检测`);
      }
    }
  } catch (err) {
    findings.push({
      note: `递归解压检测异常: ${err.message}`,
      skipped: true,
    });
  } finally {
    // 清理临时解压目录
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  return findings;
}

// ============================================================
// 主入口函数
// ============================================================

/**
 * 检查目录中所有文件的压缩包属性
 *
 * @param {string} folderPath - 上传目录路径
 * @param {object} config - 压缩包检测配置
 * @param {boolean} config.blockEncryptedArchives - 是否阻止加密压缩包
 * @param {boolean} config.detectArchiveByContent - 是否通过文件内容检测（魔数）
 * @param {boolean} config.recursiveArchiveCheck - 是否递归检测压缩包内文件
 * @returns {{ files: Array, blocked: boolean, blockReasons: string[], archivesFound: number, encryptedFound: number }}
 */
async function inspectArchives(folderPath, config) {
  const {
    blockEncryptedArchives = true,
    sevenZipPath = '',
  } = config;

  // detectArchiveByContent 和 recursiveArchiveCheck 仅在开启 blockEncryptedArchives 时生效
  let detectArchiveByContent = config.detectArchiveByContent === true;
  let recursiveArchiveCheck = config.recursiveArchiveCheck === true;
  if (!blockEncryptedArchives) {
    detectArchiveByContent = false;
    recursiveArchiveCheck = false;
  }

  const result = {
    files: [],
    blocked: false,
    blockReasons: [],
    archivesFound: 0,
    encryptedFound: 0,
    virusDetected: false,
    virusMissing: 0,
    virusMissingFiles: [],
    virusBeforeCount: 0,
    virusAfterCount: 0,
  };

  // 列出目录中的所有文件（仅顶层）
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch (err) {
    result.blockReasons.push(`无法读取上传目录: ${err.message}`);
    return result;
  }

  const files = dirEntries.filter(e => e.isFile());

  for (const entry of files) {
    const fileName = entry.name;
    const filePath = path.join(folderPath, fileName);
    const fileResult = {
      fileName,
      isArchive: false,
      archiveType: null,
      detectionMethod: 'extension',
      isEncrypted: false,
      encryptionConfirmed: false,
      contents: [],
      recursiveFindings: [],
      warnings: [],
    };

    let archiveType = null;
    let detectedByContent = false;

    // 1. 确定是否为压缩文件
    if (detectArchiveByContent) {
      // 始终通过文件内容检测
      archiveType = detectArchiveType(filePath);
      if (archiveType) {
        detectedByContent = true;
      } else if (isArchiveExtension(fileName)) {
        // 魔数未识别但扩展名匹配
        archiveType = getArchiveTypeByExtension(fileName);
      }
    } else {
      // 仅通过扩展名判断
      if (isArchiveExtension(fileName)) {
        archiveType = getArchiveTypeByExtension(fileName);
        // 如果扩展名匹配但需要确认，可再验证魔数
        const contentType = detectArchiveType(filePath);
        if (contentType && contentType !== archiveType) {
          // 魔数与扩展名不匹配，记录警告
          fileResult.warnings.push(
            `文件扩展名为 .${archiveType}，但魔数检测为 ${contentType}`
          );
        }
        if (!contentType) {
          fileResult.warnings.push(
            `文件扩展名为 .${archiveType}，但魔数检测未确认为压缩文件`
          );
        }
      }
    }

    if (!archiveType) {
      // 非压缩文件，跳过详细检测
      result.files.push(fileResult);
      continue;
    }

    // 2. 确认是压缩文件，设置基本信息
    fileResult.isArchive = true;
    fileResult.archiveType = archiveType;
    fileResult.detectionMethod = detectedByContent ? 'content' : 'extension';
    result.archivesFound++;

    // 3. 根据压缩文件类型进行加密检测和内容列挙
    //    优先使用 7z 进行检测（支持更多格式、更可靠、可实际解压测试）
    //    无 7z 时回退到纯 JS 解析
    try {
      let checkResult = null;
      let used7z = false;

      // 3a. 优先使用 7z 检测
      if (sevenZipPath) {
        checkResult = checkArchiveWith7z(sevenZipPath, filePath);
        if (checkResult) {
          used7z = true;
        }
      }

      // 3b. 7z 不可用或失败时，回退到纯 JS 解析
      if (!checkResult) {
        switch (archiveType) {
          case 'zip':
            checkResult = checkZipArchive(filePath);
            break;
          case 'rar': {
            const rarVer = detectRarVersion(filePath);
            if (rarVer === 5) {
              checkResult = checkRar5Archive(filePath);
            } else {
              checkResult = checkRar4Archive(filePath);
            }
            break;
          }
          case '7z':
            checkResult = check7zArchive(filePath);
            break;
          case 'tar':
          case 'gz':
          case 'bz2':
          case 'xz':
          case 'iso':
            checkResult = checkSimpleArchive(filePath, archiveType);
            break;
          default:
            checkResult = { encrypted: false, encryptionConfirmed: false, contents: [], warnings: ['不支持的压缩格式'] };
        }
      }

      fileResult.isEncrypted = checkResult.encrypted;
      fileResult.encryptionConfirmed = checkResult.encryptionConfirmed;
      fileResult.contents = checkResult.contents || [];
      fileResult.warnings.push(...(checkResult.warnings || []));

      // 记录是否进行了 7z 解压测试
      if (checkResult.decompressionTested !== undefined) {
        fileResult.decompressionTested = checkResult.decompressionTested;
        fileResult.decompressionPassed = checkResult.decompressionPassed;
      }
      if (used7z) {
        fileResult.detectionMethod = '7z';
      }
    } catch (err) {
      fileResult.warnings.push(`压缩包解析异常: ${err.message}`);
    }

    // 4. 递归检测压缩包内文件
    //    开启 7z 时：实际解压到临时目录，再对所有解压文件进行检测
    //    未开启 7z 时：仅通过文件名后缀判断嵌套压缩包
    //    开启病毒检测时，即使未开启递归检测也要解压（用于对比文件列表）
    if ((recursiveArchiveCheck || config.enableVirusDetect) && fileResult.contents.length > 0) {
      if (sevenZipPath && !fileResult.isEncrypted) {
        // 使用 7z 解压后实际检测解压出的文件
        const currentDepth = config._depth || 0;
        fileResult.recursiveFindings = await extractAndRecheck(sevenZipPath, filePath, config, currentDepth);

        // 递归检测到病毒时，向上传递
        if (fileResult.recursiveFindings._virusDetected) {
          result.virusDetected = true;
          result.virusMissing = fileResult.recursiveFindings._virusMissing || 0;
          result.virusMissingFiles = fileResult.recursiveFindings._virusMissingFiles || [];
          result.virusBeforeCount = fileResult.recursiveFindings._virusBeforeCount || 0;
          result.virusAfterCount = fileResult.recursiveFindings._virusAfterCount || 0;
          delete fileResult.recursiveFindings._virusDetected;
          delete fileResult.recursiveFindings._virusMissing;
          delete fileResult.recursiveFindings._virusMissingFiles;
          delete fileResult.recursiveFindings._virusBeforeCount;
          delete fileResult.recursiveFindings._virusAfterCount;
        }

        // 递归检测到加密文件时，向上传递阻止信号
        if (fileResult.recursiveFindings._blocked) {
          result._recursiveBlocked = true;
          fileResult.recursiveFindings._blockReasons.forEach(reason => {
            result.blockReasons.push(`[递归] ${reason}`);
          });
          delete fileResult.recursiveFindings._blocked;
          delete fileResult.recursiveFindings._blockReasons;
        }
      } else {
        // 仅通过文件名后缀判断（无 7z 或文件已加密无法解压）
        fileResult.recursiveFindings = recursiveInspect(
          fileResult.contents,
          { sevenZipPath: sevenZipPath || '' },
          filePath
        );
      }
    }

    // 5. 统计加密文件
    if (fileResult.isEncrypted) {
      result.encryptedFound++;
    }

    // 递归检测中发现的加密文件也要统计
    if (fileResult.recursiveFindings && fileResult.recursiveFindings.length > 0) {
      for (const rf of fileResult.recursiveFindings) {
        if (rf.isEncrypted) {
          result.encryptedFound++;
        }
      }
    }

    result.files.push(fileResult);
  }

  // 6. 判断是否需要阻止上传（直接上传 + 递归检测到的加密文件）
  if (blockEncryptedArchives && result.encryptedFound > 0) {
    result.blocked = true;
    const encryptedNames = [];

    for (const f of result.files) {
      if (f.isEncrypted) {
        encryptedNames.push(
          `${f.fileName} (${f.archiveType.toUpperCase()}${f.encryptionConfirmed ? '' : '，启发式检测'})`
        );
      }
      if (f.recursiveFindings && f.recursiveFindings.length > 0) {
        for (const rf of f.recursiveFindings) {
          if (rf.isEncrypted) {
            encryptedNames.push(
              `[递归] ${rf.fileName || rf.path} (${(rf.archiveType || '').toUpperCase()}${rf.encryptionConfirmed ? '' : '，启发式检测'})`
            );
          }
        }
      }
    }

    result.blockReasons.push(`检测到加密压缩文件: ${encryptedNames.join(', ')}`);
  }

  // 递归检测中发现的阻止信号
  if (result._recursiveBlocked && result.blocked) {
    delete result._recursiveBlocked;
  }
  if (result._recursiveBlocked) {
    result.blocked = true;
    delete result._recursiveBlocked;
  }

  return result;
}

/**
 * 检测 RAR 版本（4 或 5）
 */
function detectRarVersion(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = readBytes(fd, 0, 8);
    if (buf.length >= 8 &&
        buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21 &&
        buf[4] === 0x1A && buf[5] === 0x07) {
      if (buf[6] === 0x01 && buf[7] === 0x00) return 5;
      return 4;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = { inspectArchives, detectArchiveType };
