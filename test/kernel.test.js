'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ProfileStore } = require('../src/store');
const { nativeEnvironment, nativeAsset } = require('../src/nativecore');
const { buildBackend } = require('../src/server');
const { createWindowBridge } = require('../src/native-window-bridge');
test('switching core keeps Chrome data, validates hardware and stores native settings without script noise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-kernel-unit-'));
  try {
    const store = new ProfileStore(dir), old = store.create({ fingerprintMode: 'hardware' });
    fs.mkdirSync(path.join(store.profileDir(old.id), 'Default'), { recursive: true });
    fs.writeFileSync(path.join(store.profileDir(old.id), 'Default', 'cookie-fixture'), 'preserved');
    const kernel = store.update(old.id, { fingerprintMode: 'kernel' });
    assert.equal(kernel.deviceMemory, null); assert.equal(kernel.canvasNoise, false); assert.equal(kernel.audioNoise, false);
    assert.equal(fs.readFileSync(path.join(store.profileDir(old.id), 'Default', 'cookie-fixture'), 'utf8'), 'preserved');
    assert.equal(store.update(old.id, { name: 'new name' }).fingerprintSeed, kernel.fingerprintSeed);
    assert.throws(() => store.create({ fingerprintMode: 'kernel', hardwareConcurrency: 0 }), /CPU/);
    assert.throws(() => store.create({ fingerprintMode: 'kernel', gpuPreset: '__proto__' }), /显卡/);
    const env = nativeEnvironment({ addons: ['C:\\用户\\内核'], timezone: 'Asia/Shanghai' }, { 'browser.download.dir': 'C:\\下载' });
    assert.ok(/^[\x00-\x7f]+$/.test(env.CAMOU_CONFIG_1));
    assert.deepEqual(JSON.parse(env.CAMOU_CONFIG_1).addons, ['C:\\用户\\内核']);
    assert.equal(nativeAsset('win32', 'x64').sha256.length, 64);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('window extension capability cannot read the general API, expires, and rejects foreign origins', async () => {
  const http = require('http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-kernel-bridge-')), backend = buildBackend(dir);
  const server = http.createServer(backend.app.callback()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`, token = 'a'.repeat(48);
  const headers = { 'X-CIKE-Window-Token': token, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url + '/browserWindows', { headers })).status, 401);
    backend.browsers.windowTokens.set(token, { ready: false });
    assert.equal((await fetch(url + '/profiles', { headers })).status, 401);
    assert.equal((await fetch(url + '/browserWindows', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    const state = await (await fetch(url + '/browserWindows', { headers })).json(); assert.equal(state.state, 'maximized');
    assert.equal((await fetch(url + '/browserWindows', { method: 'PATCH', headers, body: JSON.stringify({ state: 'fullscreen' }) })).status, 200);
    assert.equal(backend.settings.get().browserWindowState, 'fullscreen');
    backend.browsers.windowTokens.delete(token);
    assert.equal((await fetch(url + '/browserWindows', { headers })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('window bridge uses a private IPv4 loopback listener and exposes only the scoped window endpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-window-ip-')), backend = buildBackend(dir);
  const token = 'b'.repeat(48); backend.browsers.windowTokens.set(token, { ready: false });
  const bridge = await createWindowBridge(backend.app.callback(), token);
  const headers = { 'X-CIKE-Window-Token': token };
  try {
    const url = new URL(bridge.url); assert.equal(require('net').isIP(url.hostname), 4); assert.ok(url.hostname.startsWith('127.'));
    assert.notEqual(url.hostname, '127.0.0.1'); assert.ok(!bridge.url.includes(token));
    assert.equal((await fetch(bridge.url)).status, 401);
    assert.equal((await fetch(bridge.url, { headers })).status, 200);
    assert.equal((await fetch(new URL('/api/profiles', bridge.url), { headers: { 'X-API-Token': backend.token } })).status, 404);
    backend.browsers.windowTokens.delete(token);
    assert.equal((await fetch(bridge.url, { headers })).status, 401);
    await bridge.close(); await assert.rejects(fetch(bridge.url, { headers }));
  } finally { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unavailable window transport preserves a healthy proxied browser; actual engine failures still fail and clean up', async () => {
  const { EventEmitter } = require('events');
  const runtime = require('../src/native-runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-window-optional-'));
  const backend = buildBackend(dir, { startPage: false, checkProxy: async () => ({ status: 'ok', exitIp: '192.0.2.1' }) });
  const profile = backend.store.create({ fingerprintMode: 'kernel', locale: 'en-US', timezone: 'UTC', proxy: { server: 'http://127.0.0.1:12345' } });
  const page = new EventEmitter(); page.isClosed = () => false;
  const context = new EventEmitter(); context.pages = () => [page]; context.close = async () => context.emit('close');
  let transportClosed = false;
  mock.method(runtime, 'launchNative', async options => {
    assert.equal(options.proxy.server, profile.proxy.server); assert.equal(options.bridge, undefined); return context;
  });
  backend.browsers.createWindowBridge = async () => { throw Object.assign(new Error('blocked'), { code: 'EACCES' }); };
  try {
    const result = await backend.browsers.open(profile.id);
    assert.equal(result.open, true); assert.match(result.warning, /可手动调整窗口/);
    assert.equal(backend.browsers.getContext(profile.id), context); assert.equal(backend.browsers.windowTokens.size, 0);
    await backend.browsers.closeAll();
    mock.restoreAll();
    mock.method(runtime, 'launchNative', async () => { throw new Error('engine-launch-failed'); });
    backend.browsers.createWindowBridge = async token => ({ url: 'http://127.2.3.4:12345/api/browserWindows', token,
      close: async () => { transportClosed = true; } });
    await assert.rejects(backend.browsers.open(profile.id), /engine-launch-failed/);
    assert.equal(transportClosed, true); assert.equal(backend.browsers.windowTokens.size, 0); assert.equal(backend.browsers.isOpen(profile.id), false);
  } finally { mock.restoreAll(); await backend.browsers.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});
