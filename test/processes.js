'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

function processCommands() {
  if (process.platform === 'win32') {
    return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  }
  return execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
}

module.exports = { processCommands };
