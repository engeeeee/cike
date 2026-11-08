'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJSON } = require('./privatefiles');
const { BUILD } = require('./nativecore');

// Store a small local report, never a memory dump, URL, proxy credential or
// unfiltered Playwright log (which can contain a site's URL).
function failureDetails(error) {
  const text = String(error?.message || error || '');
  return {
    targetCrashed: /Target crashed|Page crashed/i.test(text),
    gpuProcessFailed: /Failed to launch GPU process/i.test(text),
    d3d11Unavailable: /FEATURE_FAILURE_D3D11_NO_DEVICE|failed to get compositor device/i.test(text),
    softwareFramebufferFailed: /RenderCompositorSWGL failed mapping/i.test(text),
    jugglerSessionMissing: /cannot find session with id/i.test(text),
    jugglerChannelRedeclared: /redeclaration of let SimpleChannel/i.test(text),
    timedOut: /Timeout|timed out/i.test(text),
  };
}
const SAFE_FIELDS = ['ProcessType', 'MozCrashReason', 'OOMAllocationSize', 'AdapterVendorID', 'AdapterDeviceID', 'AdapterDriverVersion', 'WindowsVersion', 'GraphicsCriticalError'];
function crashEvents(directory) {
  const events = path.join(directory, 'crashes', 'events'), result = [];
  try {
    const files = fs.readdirSync(events).filter(name => /^[a-zA-Z0-9_.-]+$/.test(name)).map(name => ({ name, stat: fs.lstatSync(path.join(events, name)) }))
      .filter(({ stat }) => stat.isFile() && stat.size < 256 * 1024).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 4);
    for (const { name } of files) {
      const text = fs.readFileSync(path.join(events, name), 'utf8');
      const offset = text.indexOf('{'); if (offset < 0) continue;
      const data = JSON.parse(text.slice(offset));
      const safe = {};
      for (const field of SAFE_FIELDS) if (typeof data[field] === 'string' || typeof data[field] === 'number') {
        // Native annotations can still embed a path/URL in a reason string.
        safe[field] = String(data[field]).slice(0, 2000).replace(/(?:https?|socks5?):\/\/[^\s"']+/gi, '[address]').replace(/[A-Z]:\\[^\r\n"']+/gi, '[path]');
      }
      if (Object.keys(safe).length) result.push(safe);
    }
  } catch { /* A crash may not have finished writing its event yet. */ }
  return result;
}
function recordFailure(dataDir, id, directory, { event, mode, error, context }) {
  try {
    let logs = '';
    try { logs = context._connection.toImpl(context)._browser.options.browserLogsCollector.recentLogs().join('\n'); } catch {}
    const file = path.join(dataDir, 'diagnostics', id + '.json');
    writeJSON(file, { appVersion: require('../package.json').version, kernel: BUILD, os: { platform: process.platform, release: os.release(), arch: process.arch },
      time: new Date().toISOString(), profile: id, event, graphicsMode: mode || null,
      flags: failureDetails(String(error?.message || '') + '\n' + logs), crashes: crashEvents(directory) });
    return file;
  } catch (error) { console.error('[CIKE] diagnostics:', error.code || 'write failed'); return null; }
}
module.exports = { recordFailure, failureDetails, crashEvents };
