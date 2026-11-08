'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startBackend } = require('../src/server');
const { Settings } = require('../src/settings');
const { BUILD } = require('../src/nativecore');
const runtime = require('../src/native-runtime');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(read, predicate) {
  for (let n = 0; n < 160; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Software graphics verification timed out');
}
test('Windows software compositor opens new native windows from a Chinese kernel path, keeps proxy/login data and restores hardware preferences',
  { skip: !process.env.CIKE_CAMOUFOX_EXECUTABLE || (process.platform !== 'win32' && !process.env.DISPLAY), timeout: 240000 }, async () => {
    const original = process.env.CIKE_CAMOUFOX_EXECUTABLE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-gfx-profile-'));
    const kernelRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'cike-浏览器内核-'));
    const kernel = path.join(kernelRoot, `camoufox-${BUILD}-gputst`);
    let direct = 0, proxyRequests = 0, backend;
    const target = http.createServer((_request, response) => { direct++; response.end('direct'); }); await listen(target);
    const html = '<!doctype html><style>body{background:linear-gradient(90deg,#357,#b84);height:100vh}div{width:200px;height:100px;background:#4d8;animation:move 1s infinite alternate}@keyframes move{to{transform:translateX(100px)}}</style><div>software-paint-fixture</div><canvas width="800" height="600"></canvas>';
    const proxy = http.createServer((_request, response) => { proxyRequests++; response.setHeader('Content-Type', 'text/html'); response.end(html); }); await listen(proxy);
    const modes = [], launch = runtime.launchNative;
    let injectCrash = process.platform === 'win32';
    try {
      function clone(from, to) {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
          if (entry.name === '.cike-camoufox.json') continue;
          const a = path.join(from, entry.name), b = path.join(to, entry.name);
          if (entry.isDirectory()) clone(a, b);
          else if (entry.isFile()) { try { fs.linkSync(a, b); } catch (error) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(a, b); } }
          else throw new Error('Unexpected link in test kernel');
        }
      }
      clone(path.dirname(original), kernel);
      process.env.CIKE_CAMOUFOX_EXECUTABLE = path.join(kernel, path.basename(original));
      mock.method(runtime, 'launchNative', async options => {
        modes.push(options.graphicsMode);
        if (injectCrash) { injectCrash = false; throw new Error('Target crashed\nFailed to launch GPU process after 3 attempts\nFEATURE_FAILURE_D3D11_NO_DEVICE'); }
        return launch(options);
      });
      backend = await startBackend(dir, { startPage: false, checkProxy: async () => ({ status: 'ok', exitIp: '192.0.2.1' }) });
      backend.settings.set({ camoufoxGraphicsMode: process.platform === 'win32' ? 'auto' : 'software', browserWindowMode: 'fullscreen' });
      const create = name => backend.store.create({ name, fingerprintMode: 'kernel', hardwareConcurrency: 4, gpuPreset: 'native', locale: 'en-US', timezone: 'UTC',
        proxy: { server: `http://127.0.0.1:${proxy.address().port}` } });
      const a = create('software A'), b = create('software B'), manager = backend.browsers;
      const result = await manager.open(a.id); assert.equal(result.graphicsMode, 'software');
      if (process.platform === 'win32') {
        assert.deepEqual(modes, ['hardware', 'software']); assert.match(result.warning, /D3D11/);
        assert.equal(new Settings(dir).get().camoufoxAutoSoftware, true);
      }
      const context = manager.getContext(a.id), page = context.pages()[0], url = `http://127.0.0.1:${target.address().port}/graphics`;
      await page.goto(url);
      assert.deepEqual(await page.evaluate(() => {
        const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'); ctx.fillStyle = '#2578ab'; ctx.fillRect(0, 0, 800, 600);
        document.cookie = 'graphics=retained; path=/; max-age=3600'; localStorage.setItem('graphics', 'retained');
        return { pixel: [...ctx.getImageData(0, 0, 1, 1).data], native: /\[native code\]/.test(CanvasRenderingContext2D.prototype.getImageData.toString()) };
      }), { pixel: [37, 120, 171, 255], native: true });
      assert.ok((await page.screenshot()).length > 1000);
      for (let n = 0; n < 3; n++) {
        const opened = context.waitForEvent('page'); await page.evaluate(({ url, n }) => { window.open(url, 'graphics-' + n, 'popup,width=600,height=500'); }, { url, n });
        const popup = await opened; await popup.waitForLoadState();
        assert.match(await popup.locator('body').innerText(), /software-paint-fixture/);
        if (process.platform === 'win32') await until(() => popup.evaluate(() => Math.abs(outerWidth - screen.width) <= 2 && Math.abs(outerHeight - screen.height) <= 2), Boolean);
        assert.equal(manager.isOpen(a.id), true);
      }
      await manager.open(b.id); assert.equal(manager.listOpen().find(item => item.profile_id === b.id).graphicsMode, 'software');
      if (process.platform === 'win32') {
        const root = (kernel + path.sep).replaceAll("'", "''");
        const script = `$root='${root}'; $gpu=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -match '(?i)(^|\\s)gpu(\\s|$)' }); [Console]::Write($gpu.Count)`;
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const count = require('child_process').execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000 }).trim();
        assert.equal(count, '0', 'Compatibility windows must not launch a GPU child process');
      }
      await manager.closeAll(); await manager.open(a.id);
      const reopened = manager.getContext(a.id).pages()[0]; await reopened.goto(url);
      assert.deepEqual(await reopened.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem('graphics') })), { cookie: 'graphics=retained', local: 'retained' });
      assert.equal(direct, 0); assert.ok(proxyRequests > 0);
      await manager.closeAll();
      const userFile = path.join(backend.store.profileDir(a.id), 'firefox', 'user.js');
      assert.match(fs.readFileSync(userFile, 'utf8'), /user_pref\("layers.gpu-process.enabled", false\)/);
      const effectivePrefs = fs.readFileSync(path.join(path.dirname(userFile), 'prefs.js'), 'utf8');
      // Values equal to CAMOU_PREFS defaults are omitted by Firefox on save.
      // No stale opposite user value may override compatibility on restart.
      assert.doesNotMatch(effectivePrefs, /user_pref\("gfx.webrender.software", false\)/);
      if (process.platform === 'win32') assert.doesNotMatch(effectivePrefs, /user_pref\("gfx.webrender.software.d3d11", true\)/);
      console.log('Verified software graphics with native canvas painting, screenshots and new windows:', kernel);
      backend.settings.set({ camoufoxGraphicsMode: 'hardware' });
      await manager.open(a.id); await manager.closeAll();
      const prefs = fs.readFileSync(userFile, 'utf8');
      assert.match(prefs, /user_pref\("gfx.webrender.software", false\)/);
      if (process.platform === 'win32') assert.match(prefs, /user_pref\("gfx.webrender.software.d3d11", true\)/);
      assert.equal(new Settings(dir).get().camoufoxAutoSoftware, false);
      assert.ok(fs.existsSync(original));
    } finally {
      mock.restoreAll(); await backend?.browsers.closeAll(); if (backend) await new Promise(resolve => backend.server.close(resolve));
      for (const server of [target, proxy]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      process.env.CIKE_CAMOUFOX_EXECUTABLE = original;
      fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(kernelRoot, { recursive: true, force: true });
    }
  });
