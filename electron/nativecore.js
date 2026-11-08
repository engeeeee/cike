'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { nativeAsset, nativeMarker, nativeExecutable, BUILD } = require('../src/nativecore');
const { extractBrowserZip } = require('../src/zip');
const { writePrivate } = require('../src/privatefiles');
const { downloadFile } = require('./chromium');
const { NativeStorage, renameKernel } = require('../src/native-storage');
const pending = new Map();
async function verifyNativeExecutable(executable) {
  const version = fs.readFileSync(path.join(path.dirname(executable), 'application.ini'), 'utf8').match(/^Version=(.+)$/m)?.[1].trim();
  if (version !== BUILD) throw new Error('指纹内核版本不匹配');
  const browser = await require('playwright-native').firefox.launch({ executablePath: executable, headless: true, timeout: 30000 });
  await browser.close();
}
async function nativeStatus(dir) {
  try { return { installed: true, executable: nativeExecutable(dir), version: BUILD }; }
  catch { return { installed: false, executable: null, version: BUILD }; }
}
async function install(dir, onProgress) {
  const current = await nativeStatus(dir);
  if (current.installed) return current.executable;
  const storage = new NativeStorage(dir, { verify: verifyNativeExecutable });
  const asset = nativeAsset(), root = storage.root();
  fs.mkdirSync(root, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-camoufox-'));
  const staging = fs.mkdtempSync(path.join(root, '.camoufox-install-'));
  try {
    const archive = path.join(temporary, asset.name);
    await downloadFile(asset.url, archive, onProgress, 0, 2 * 1024 * 1024 * 1024);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) throw new Error('指纹内核 SHA-256 校验失败，未安装');
    onProgress?.({ pct: 100, phase: '正在校验和解压内核…' });
    await extractBrowserZip(archive, staging);
    const basename = process.platform === 'win32' ? 'camoufox.exe' : 'camoufox';
    const executable = path.join(staging, basename);
    if (!fs.existsSync(executable)) throw new Error('压缩包中没有 Camoufox');
    // Probe the exact pinned Juggler/Playwright pair before publishing the marker.
    await verifyNativeExecutable(executable);
    const destination = path.join(root, `camoufox-${BUILD}-${path.basename(staging).slice(-6)}`);
    await renameKernel(staging, destination);
    const final = path.join(destination, basename);
    storage.register(destination, BUILD);
    writePrivate(nativeMarker(dir), final + '\n');
    onProgress?.({ pct: 100, phase: '安装完成' });
    return final;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
}
async function downloadNative(dir, onProgress) {
  if (pending.has(dir)) return pending.get(dir);
  const promise = install(dir, onProgress); pending.set(dir, promise);
  try { return await promise; } finally { pending.delete(dir); }
}
module.exports = { nativeStatus, downloadNative, verifyNativeExecutable };
