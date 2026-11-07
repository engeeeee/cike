'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { startBackend } = require('../src/server');
async function until(read, predicate) {
  for (let n = 0; n < 160; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Native window state did not settle');
}
test('Camoufox native windows default to maximized and inherit manual F11 into popups, new environments and restart',
  { skip: process.platform !== 'win32' || !process.env.CIKE_CAMOUFOX_EXECUTABLE, timeout: 120000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-kernel-windows-'));
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
      await until(() => page.evaluate(() => Math.abs(outerWidth - screen.availWidth) <= 20 && Math.abs(outerHeight - screen.availHeight) <= 20), Boolean);
      // Firefox's automation keyboard dispatches into content, not the browser
      // chrome. Send the actual Windows shortcut to this browser's process.
      const pid = context._connection.toImpl(context)._browser.options.browserProcess.process.pid;
      assert.ok(Number.isSafeInteger(pid));
      const script = ['$cikeShell = New-Object -ComObject WScript.Shell',
        `if (-not $cikeShell.AppActivate(${pid})) { throw 'Could not focus the native test browser' }`,
        'Start-Sleep -Milliseconds 300', '$cikeShell.SendKeys("{F11}")'].join('\n');
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
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
    } finally { await manager.closeAll(); await new Promise(resolve => backend.server.close(resolve)); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
  });
