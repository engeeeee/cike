'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { startBackend } = require('../src/server');
const { createWindowBridge } = require('../src/native-window-bridge');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
async function until(read, predicate) {
  for (let n = 0; n < 160; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Window component did not reconnect');
}

test('a delayed window component never closes the SOCKS5 browser, reconnects, and reopens existing Unicode profiles with fresh control resources',
  { skip: !process.env.CIKE_CAMOUFOX_EXECUTABLE || (process.platform !== 'win32' && !process.env.DISPLAY), timeout: 90000 }, async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-window-startup-'));
    const directory = path.join(parent, '中文 用户 默认位置');
    let direct = 0, authenticated = 0, controlRequests = 0, legacyControlRequests = 0, available = false;
    const destinations = [], sockets = new Set(), bridges = [];
    const target = http.createServer((_request, response) => { direct++; response.end('direct'); }); await listen(target);
    const fixture = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>SOCKS fixture</title>authenticated-socks-fixture'); }); await listen(fixture);
    // Reproduce an existing Firefox profile inheriting a separate system/manual
    // proxy. A Playwright bypass alone would still send control traffic there.
    const legacyProxy = http.createServer((request, response) => { if (request.url.includes('/api/browserWindows')) legacyControlRequests++; response.writeHead(502); response.end(); });
    legacyProxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')); await listen(legacyProxy);
    const socks = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      let data = Buffer.alloc(0), stage = 0;
      const receive = chunk => {
        data = Buffer.concat([data, chunk]);
        for (;;) {
          if (stage === 0) {
            if (data.length < 2 || data.length < 2 + data[1]) return;
            data = data.subarray(2 + data[1]); socket.write(Buffer.from([5, 2])); stage++;
          } else if (stage === 1) {
            if (data.length < 2 || data.length < 3 + data[1]) return;
            const n = data[1], m = data[2 + n]; if (data.length < 3 + n + m) return;
            const accepted = data.subarray(2, 2 + n).toString() === 'fixture' && data.subarray(3 + n, 3 + n + m).toString() === 'secret';
            if (accepted) authenticated++;
            data = data.subarray(3 + n + m); socket.write(Buffer.from([1, accepted ? 0 : 1])); if (!accepted) { socket.end(); return; } stage++;
          } else {
            if (data.length < 5) return;
            const n = data[4]; if (data[3] !== 3 || data.length < 7 + n) return;
            const host = data.subarray(5, 5 + n).toString(), port = data.readUInt16BE(5 + n);
            destinations.push({ host, port });
            if (port !== target.address().port) { socket.end(Buffer.from([5, 5, 0, 1, 127, 0, 0, 1, 0, 0])); return; }
            const tail = data.subarray(7 + n); socket.off('data', receive);
            const upstream = net.connect(fixture.address().port, '127.0.0.1', () => {
              socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (tail.length) upstream.write(tail);
              socket.pipe(upstream); upstream.pipe(socket);
            });
            upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy()); return;
          }
        }
      };
      socket.on('data', receive);
    }); await listen(socks);
    const backend = await startBackend(directory, { startPage: false, checkProxy: async () => ({ status: 'ok', exitIp: '192.0.2.1' }) });
    backend.browsers.createWindowBridge = async token => {
      const bridge = await createWindowBridge((request, response) => { controlRequests++; if (available) backend.app.callback()(request, response); }, token);
      bridges.push(bridge); return bridge;
    };
    const profile = backend.store.create({ fingerprintMode: 'kernel', gpuPreset: 'native', locale: 'en-US', timezone: 'UTC',
      proxy: { server: `socks5://127.0.0.1:${socks.address().port}`, username: 'fixture', password: 'secret' } });
    const firefoxDirectory = path.join(backend.store.profileDir(profile.id), 'firefox'); fs.mkdirSync(firefoxDirectory, { recursive: true });
    fs.writeFileSync(path.join(firefoxDirectory, 'user.js'), 'user_pref("cike.fixture.preserve", "keep-user-setting");\n');
    fs.writeFileSync(path.join(firefoxDirectory, 'prefs.js'), [
      'user_pref("network.proxy.type", 1);', 'user_pref("network.proxy.http", "127.0.0.1");',
      `user_pref("network.proxy.http_port", ${legacyProxy.address().port});`, 'user_pref("network.proxy.no_proxies_on", "");',
    ].join('\n'));
    const manager = backend.browsers, url = `http://127.0.0.1:${target.address().port}/fixture`;
    try {
      const result = await manager.open(profile.id); assert.equal(result.open, true); assert.match(result.warning, /正在重试/);
      const page = manager.getContext(profile.id).pages()[0];
      await page.goto(url); assert.equal(await page.locator('body').innerText(), 'authenticated-socks-fixture');
      await page.evaluate(() => { document.cookie = 'startup=retained; path=/; max-age=3600'; localStorage.setItem('startup', 'retained'); });
      // Exceed the old fatal handshake deadline while the component is blocked.
      await new Promise(resolve => setTimeout(resolve, 21000));
      assert.equal(manager.isOpen(profile.id), true); assert.equal(page.isClosed(), false); assert.ok(controlRequests >= 2);
      await page.reload(); assert.equal(await page.locator('body').innerText(), 'authenticated-socks-fixture');
      assert.equal(direct, 0); assert.ok(authenticated > 0);
      assert.equal(legacyControlRequests, 0);
      assert.ok(destinations.every(destination => destination.host !== new URL(bridges[0].url).hostname));
      backend.settings.set({ browserWindowMode: 'fullscreen' }); available = true;
      await until(() => manager.windowWarning(profile.id), warning => warning === null);
      if (process.platform === 'win32') await until(() => page.evaluate(() => Math.abs(outerHeight - screen.height) <= 2 && Math.abs(outerWidth - screen.width) <= 2), Boolean);
      const oldToken = bridges[0].token;
      await manager.closeAll(); await assert.rejects(fetch(bridges[0].url));
      assert.equal(manager.windowTokens.size, 0);
      await manager.open(profile.id);
      await until(() => manager.windowWarning(profile.id), warning => warning === null);
      assert.notEqual(bridges[1].url, bridges[0].url);
      assert.ok(!fs.existsSync(path.join(backend.store.profileDir(profile.id), 'firefox', 'cike-window-extension', oldToken)));
      const userPrefs = fs.readFileSync(path.join(firefoxDirectory, 'user.js'), 'utf8');
      assert.ok(userPrefs.includes('keep-user-setting')); assert.equal(userPrefs.match(/CIKE window bridge BEGIN/g).length, 1);
      const reopened = manager.getContext(profile.id).pages()[0]; await reopened.goto(url);
      assert.deepEqual(await reopened.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem('startup') })), { cookie: 'startup=retained', local: 'retained' });
      assert.equal(direct, 0);
    } finally {
      await manager.closeAll(); await Promise.all(bridges.map(bridge => bridge.close()));
      await close(backend.server); for (const socket of sockets) socket.destroy(); await close(socks); await close(target); await close(fixture); await close(legacyProxy);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
