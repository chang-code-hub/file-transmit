const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Scan a file/folder with Huorong antivirus (Windows only).
 * Returns a promise that resolves with {clean: true/false, threat?: string}.
 */
function scanFile(filePath) {
  return new Promise((resolve) => {
    // Only supported on Windows
    if (os.platform() !== 'win32') {
      console.log('[杀毒] 非 Windows 系统，跳过病毒扫描');
      return resolve({ clean: true, skipped: true });
    }

    // Try to find Huorong scanner
    const possiblePaths = [
      'C:\\Program Files\\Huorong\\Sysdiag\\bin\\HipsMain.exe',
      'C:\\Program Files (x86)\\Huorong\\Sysdiag\\bin\\HipsMain.exe',
    ];

    let scannerPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        scannerPath = p;
        break;
      }
    }

    if (!scannerPath) {
      console.log('[杀毒] 未找到火绒杀毒软件，跳过扫描');
      return resolve({ clean: true, skipped: true });
    }

    console.log(`[杀毒] 开始扫描: ${filePath}`);

    // Huorong command-line scan: HipsMain.exe -s <path>
    execFile(scannerPath, ['-s', filePath], {
      timeout: 5 * 60 * 1000, // 5 minute timeout
    }, (error, stdout, stderr) => {
      if (error) {
        // Huorong exits with non-zero if threats found
        if (error.code === 1) {
          console.log(`[杀毒] 发现威胁: ${filePath}`);
          return resolve({ clean: false, threat: stdout || stderr });
        }
        console.error(`[杀毒] 扫描出错: ${error.message}`);
        return resolve({ clean: true, error: error.message });
      }

      console.log(`[杀毒] 扫描完成，无威胁: ${filePath}`);
      resolve({ clean: true });
    });
  });
}

module.exports = { scanFile };
