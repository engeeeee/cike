'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { nativeAsset, nativeMarker, nativeExecutable, nativeEnvironment, BUILD } = require('../src/nativecore');
const { extractBrowserZip } = require('../src/zip');
const { writePrivate } = require('../src/privatefiles');
const { downloadFile } = require('./chromium');
const { NativeStorage, renameKernel } = require('../src/native-storage');
const pending = new Map();
async function verifyNativeExecutable(executable) {
  const version = fs.readFileSync(path.join(path.dirname(executable), 'application.ini'), 'utf8').match(/^Version=(.+)$/m)?.[1].trim();
  if (version !== BUILD) throw new Error('指纹内核版本不匹配');
  const preferences = { ...require('../src/native-graphics').graphicsPreferences('software'),
    // The probe uses only data: pages. Block background HTTP(S) as well, so
    // checking a kernel never contacts a website through the host network.
    'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 9,
    'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 9, 'network.proxy.no_proxies_on': '',
    'network.http.http3.enable': false,
  };
  const browser = await require('playwright-native').firefox.launch({ executablePath: executable, headless: true, timeout: 30000,
    proxy: { server: 'http://127.0.0.1:9', bypass: '' }, firefoxUserPrefs: preferences, env: nativeEnvironment({}, preferences) });
  let failure;
  try {
    const context = await browser.newContext(); context.setDefaultTimeout(10000);
    // A live parent/Juggler pipe does not prove that any content process can
    // start. Keep the first page open while creating a second one as well.
    for (let n = 0; n < 2; n++) {
      const page = await context.newPage();
      await page.goto('data:text/html,<title>CIKE kernel probe</title><canvas width="1" height="1"></canvas>', { timeout: 10000 });
      const healthy = await page.evaluate(() => {
        const canvas = document.querySelector('canvas'), drawing = canvas.getContext('2d');
        drawing.fillStyle = '#123456'; drawing.fillRect(0, 0, 1, 1);
        return document.title === 'CIKE kernel probe' && [...drawing.getImageData(0, 0, 1, 1).data].join(',') === '18,52,86,255';
      });
      if (!healthy) throw new Error('内核内容页面或原生 Canvas 检查未通过');
    }
  } catch (error) { failure = error; throw error; }
  finally {
    try { await require('../src/browser-lifecycle').stopContext(browser); }
    catch (error) { if (!failure) throw error; }
  }
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
    try { await downloadFile(asset.url, archive, onProgress, 0, 2 * 1024 * 1024 * 1024); }
    catch (error) {
      if (!asset.apiUrl || !/HTTP 50\d|ECONNRESET|ETIMEDOUT|超时/i.test(error.message)) throw error;
      // Same pinned official asset, via GitHub's binary asset API when its
      // release download gateway is unavailable. Verify the same SHA below.
      fs.rmSync(archive, { force: true });
      await downloadFile(asset.apiUrl, archive, onProgress, 0, 2 * 1024 * 1024 * 1024);
    }
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
