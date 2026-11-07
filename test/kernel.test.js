'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ProfileStore } = require('../src/store');
const { nativeEnvironment, nativeAsset } = require('../src/nativecore');
const { buildBackend } = require('../src/server');
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
