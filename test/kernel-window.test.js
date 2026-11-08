'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const nativeCore = require('../src/nativecore');
const { startBackend } = require('../src/server');
async function until(read, predicate) {
  for (let n = 0; n < 160; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Native window state did not settle');
}
test('Camoufox native windows maximize and inherit a manual native fullscreen change into popups, environments and restart',
  { skip: process.platform !== 'win32' || !process.env.CIKE_CAMOUFOX_EXECUTABLE, timeout: 120000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-kernel-windows-'));
    // Hosted runners cannot foreground an OS window. An independent test-only
    // extension changes Firefox's real window state, as F11 does, without
    // calling CIKE's preference setter. The production extension must observe
    // that change, persist it and apply it to later windows.
    let fullscreen = false, injectControl = true;
    const controller = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ fullscreen }));
    });
    await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
    const extension = path.join(directory, 'window-control-fixture'); fs.mkdirSync(extension);
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Native window test controller', version: '1.0',
      browser_specific_settings: { gecko: { id: 'cike-window-test@local.invalid' } }, permissions: ['http://127.0.0.1/*'], background: { scripts: ['control.js'] } }));
    fs.writeFileSync(path.join(extension, 'control.js'), `const timer=setInterval(async()=>{try{const command=await(await fetch('http://127.0.0.1:${controller.address().port}')).json();if(!command.fullscreen)return;clearInterval(timer);for(const win of await browser.windows.getAll())await browser.windows.update(win.id,{state:'fullscreen'});}catch(error){console.error(error.message)}},200);`);
    const environment = nativeCore.nativeEnvironment;
    mock.method(nativeCore, 'nativeEnvironment', (config, preferences) => {
      if (injectControl) { config.addons.push(extension); injectControl = false; }
      return environment(config, preferences);
    });
    let controlLeaked = false;
    const proxy = http.createServer((request, response) => {
      if (request.url.includes('/api/browserWindows')) controlLeaked = true;
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html>native-window-proxy');
    });
    proxy.on('connect', (request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const backend = await startBackend(directory, { startPage: false, checkProxy: async () => ({ status: 'ok', exitIp: '192.0.2.1' }) });
    const manager = backend.browsers;
    const full = page => page.evaluate(() => Math.abs(outerHeight - screen.height) <= 2 && Math.abs(outerWidth - screen.width) <= 2);
    try {
      const a = backend.store.create({ fingerprintMode: 'kernel', gpuPreset: 'native' });
      const b = backend.store.create({ fingerprintMode: 'kernel', gpuPreset: 'native', locale: 'en-US', timezone: 'UTC', proxy: { server: `http://127.0.0.1:${proxy.address().port}` } });
      await manager.open(a.id); const context = manager.getContext(a.id), page = context.pages()[0];
      try { await until(() => page.evaluate(() => Math.abs(outerWidth - screen.availWidth) <= 20 && Math.abs(outerHeight - screen.availHeight) <= 20), Boolean); }
      catch (error) {
        const bounds = await page.evaluate(() => ({ width: outerWidth, height: outerHeight, available: [screen.availWidth, screen.availHeight], screen: [screen.width, screen.height], dpr: devicePixelRatio }));
        throw new Error(error.message + ': ' + JSON.stringify({ bounds, warning: manager.windowWarning(a.id), mode: backend.settings.get().browserWindowState }));
      }
      fullscreen = true;
      await until(() => backend.settings.get().browserWindowState, state => state === 'fullscreen');
      await until(() => full(page), Boolean);
      const popupPromise = context.waitForEvent('page');
      await page.evaluate(() => { window.open('about:blank', 'kernel-popup', 'popup,width=600,height=500'); });
      const popup = await popupPromise; await until(() => full(popup), Boolean);
      await manager.open(b.id); const proxied = manager.getContext(b.id).pages()[0]; await until(() => full(proxied), Boolean);
      await proxied.goto('http://127.0.0.1:65530/native-window-route');
      assert.equal(await proxied.locator('body').innerText(), 'native-window-proxy'); assert.equal(controlLeaked, false);
      await manager.closeAll();
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'))).browserWindowState, 'fullscreen');
      await manager.open(a.id); await until(() => full(manager.getContext(a.id).pages()[0]), Boolean);
    } finally { await manager.closeAll(); await new Promise(resolve => backend.server.close(resolve)); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); controller.closeAllConnections(); await new Promise(resolve => controller.close(resolve)); mock.restoreAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
