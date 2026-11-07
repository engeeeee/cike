'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const exec = promisify(execFile);
const { privateDirectory, writePrivate } = require('../src/privatefiles');
const { extractBrowserZip } = require('../src/zip');
const inProgress = new Map();
function chromiumEntry() {
  const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
  return JSON.parse(fs.readFileSync(file)).browsers.find(b => b.name === 'chromium');
}
function cftPlatform(platform = process.platform, arch = process.arch) {
  const target = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux64', 'win32-x64': 'win64' }[`${platform}-${arch}`];
  if (!target) throw new Error('不支持此平台的 Chromium 下载；Windows 版需要 64 位 x64 环境');
  return target;
}
function downloadUrl(platform = process.platform, arch = process.arch) {
  const host = process.env.PLAYWRIGHT_DOWNLOAD_HOST || 'https://cdn.playwright.dev';
  const target = cftPlatform(platform, arch);
  return `${host}/builds/cft/${chromiumEntry().browserVersion}/${target}/chrome-${target}.zip`;
}
function browserRoot(dir) { return path.join(dir, 'browsers'); }
function executableMarker(dir) { return path.join(browserRoot(dir), 'chromium-executable.txt'); }
async function browserVersion(executable, platform = process.platform) {
  if (platform === 'win32') {
    // chrome.exe is a GUI program on Windows: --version does not reliably
    // write to stdout. Query the running browser over Playwright's pipe.
    const browser = await require('playwright').chromium.launch({ executablePath: executable,
      headless: true, chromiumSandbox: true, timeout: 15000,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'] });
    try { return browser.version(); } finally { await browser.close(); }
  }
  const { stdout } = await exec(executable, ['--version'], { timeout: 10000, maxBuffer: 65536, windowsHide: true });
  return stdout.match(/\d+\.\d+\.\d+\.\d+/)?.[0] || null;
}
async function chromiumStatus(dir) {
  const targetVersion = chromiumEntry().browserVersion;
  try {
    const executable = fs.readFileSync(executableMarker(dir), 'utf8').trim();
    const version = await browserVersion(executable);
    if (version) return { installed: true, executable, version, targetVersion, updateAvailable: version !== targetVersion };
  } catch { /* not installed or unusable */ }
  return { installed: false, executable: null, version: null, targetVersion, updateAvailable: true };
}
async function downloadFile(url, dest, onProgress, redirects = 0, maxBytes = 1024 * 1024 * 1024) {
  if (redirects > 5 || new URL(url).protocol !== 'https:') throw new Error('内核下载必须使用 HTTPS，且不能无限重定向');
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CIKE' } }, resolve);
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('内核下载超时')));
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    return downloadFile(new URL(response.headers.location, url).href, dest, onProgress, redirects + 1, maxBytes);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`内核下载失败：HTTP ${response.statusCode}`); }
  const total = Number(response.headers['content-length']) || 0;
  let done = 0;
  response.on('data', chunk => {
    done += chunk.length;
    if (done > maxBytes) response.destroy(new Error('内核安装包异常过大'));
    onProgress?.({ done, total, pct: total ? Math.round(done / total * 100) : 0 });
  });
  await pipeline(response, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
}
function findExecutable(root, platform = process.platform) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (platform === 'darwin' && e.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        return path.join(macos, fs.readdirSync(macos).find(n => !n.startsWith('.')));
      }
      const found = findExecutable(full, platform); if (found) return found;
    } else if (e.isFile() && ((platform === 'linux' && e.name === 'chrome') || (platform === 'win32' && e.name === 'chrome.exe'))) return full;
  }
  return null;
}
async function install(dir, onProgress) {
  const status = await chromiumStatus(dir);
  if (status.installed && !status.updateAvailable) return status.executable;
  privateDirectory(browserRoot(dir));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-chromium-'));
  const staging = fs.mkdtempSync(path.join(browserRoot(dir), '.install-'));
  try {
    const zip = path.join(tmp, 'chromium.zip');
    await downloadFile(downloadUrl(), zip, onProgress);
    if (process.platform === 'darwin') await exec('/usr/bin/unzip', ['-q', zip, '-d', staging], { timeout: 600000 });
    else await extractBrowserZip(zip, staging);
    const executable = findExecutable(staging);
    if (!executable) throw new Error('安装包中没有 Chromium');
    // Playwright's CfT archive may omit bundle resource seals. Do not repair
    // that by re-signing locally or claim Developer ID validation: transport
    // trust is HTTPS to the configured CDN, followed by a version check.
    if (await browserVersion(executable) !== chromiumEntry().browserVersion) throw new Error('下载的内核版本不匹配');
    // Keep the downloaded bundle unchanged, including its icon. Old
    // kernels remain available until the new version is fully verified.
    const destination = path.join(browserRoot(dir), `${chromiumEntry().browserVersion}-${path.basename(staging).slice(9)}`);
    const relative = path.relative(staging, executable);
    fs.renameSync(staging, destination);
    const final = path.join(destination, relative);
    writePrivate(executableMarker(dir), final + '\n');
    onProgress?.({ done: 1, total: 1, pct: 100 });
    return final;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
}
async function downloadChromium(dir, onProgress) {
  if (inProgress.has(dir)) return inProgress.get(dir);
  const promise = install(dir, onProgress);
  inProgress.set(dir, promise);
  try { return await promise; } finally { inProgress.delete(dir); }
}
module.exports = { chromiumStatus, downloadChromium, downloadUrl, executableMarker, browserRoot, browserVersion, findExecutable, cftPlatform, downloadFile };
