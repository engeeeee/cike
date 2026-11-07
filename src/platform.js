'use strict';
const os = require('os');
const path = require('path');

function defaultDataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.LFB_DATA) return (platform === 'win32' ? path.win32 : path).resolve(env.LFB_DATA);
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'CIKE');
  return path.join(home, '.local-fingerprint-browser');
}

function curlRuntime(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
    return {
      executable: path.win32.join(root, 'System32', 'curl.exe'),
      env: { SystemRoot: root, WINDIR: root, PATH: path.win32.join(root, 'System32'),
        ...(env.TEMP ? { TEMP: env.TEMP } : {}), ...(env.TMP ? { TMP: env.TMP } : {}) },
    };
  }
  return { executable: '/usr/bin/curl', env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: env.HOME } };
}

module.exports = { defaultDataDirectory, curlRuntime };
