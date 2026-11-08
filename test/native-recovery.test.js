'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareProfile, CACHE_FILES } = require('../src/native-recovery');
const { stopContext } = require('../src/browser-lifecycle');
const { failureDetails, recordFailure } = require('../src/native-diagnostics');
const { BrowserManager } = require('../src/browser');
const { mock } = require('node:test');
const { EventEmitter } = require('events');
const { ProfileStore } = require('../src/store');

test('upgrading/unclean profiles back up only regenerated caches and retain every login file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-recovery-'));
  try {
    const retained = ['cookies.sqlite', 'places.sqlite', 'logins.json', 'key4.db', 'prefs.js', 'user.js', 'permissions.sqlite', 'sessionstore.jsonlz4', 'storage/default/keep'];
    for (const name of [...retained, ...CACHE_FILES.map(name => name === 'startupCache' || name === 'shader-cache' ? name + '/entry' : name)]) {
      const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name);
    }
    const first = prepareProfile(dir); assert.equal(first.repaired, true); first.close();
    const backup = fs.readdirSync(path.join(dir, 'cike-recovery'))[0];
    for (const name of CACHE_FILES) assert.ok(fs.existsSync(path.join(dir, 'cike-recovery', backup, name)));
    fs.mkdirSync(path.join(dir, 'startupCache')); fs.writeFileSync(path.join(dir, 'startupCache/new'), 'fresh');
    const second = prepareProfile(dir); assert.equal(second.repaired, false); second.close();
    const interrupted = prepareProfile(dir); assert.equal(interrupted.repaired, false); // simulate parent process dying
    const next = prepareProfile(dir); assert.equal(next.repaired, true); next.crash(); next.close();
    fs.writeFileSync(path.join(dir, 'xulstore.json'), '{}');
    const afterCrash = prepareProfile(dir); assert.equal(afterCrash.repaired, true); afterCrash.close();
    for (const name of retained) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), name);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('hung protocol closure kills only its own Playwright process; normal/unknown contexts never kill another browser', async () => {
  let kills = 0;
  const owner = { process: { pid: 123, exitCode: null, signalCode: null }, kill: async () => { kills++; owner.process.exitCode = 0; } };
  const context = { close: () => new Promise(() => {}), _connection: { toImpl: () => ({ _browser: { options: { browserProcess: owner } } }) } };
  await stopContext(context, 20); assert.equal(kills, 1);
  context.close = async () => {}; await stopContext(context, 20); assert.equal(kills, 1);
  await assert.rejects(stopContext({ close: () => new Promise(() => {}) }, 20), /关闭超时/);
});
test('cancelling a slow launch retains cancellation until the launch actually settles', async () => {
  const manager = new BrowserManager({}); let resolve;
  manager._open = async id => { await new Promise(done => { resolve = done; }); if (manager.cancelled.has(id)) throw new Error('cancelled'); };
  const opening = manager.open('fixture'); const observed = assert.rejects(opening, /cancelled/);
  await assert.rejects(manager.close('fixture'), /取消启动/);
  assert.equal(manager.cancelled.has('fixture'), true);
  resolve(); await observed; assert.equal(manager.opening.size, 0); assert.equal(manager.cancelled.size, 0);
});
test('disposing Firefox\'s last protocol target does not close a live native browser window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-native-target-'));
  const context = new EventEmitter(), page = new EventEmitter(); let pages = [page], closes = 0;
  page.isClosed = () => !pages.includes(page); context.pages = () => pages;
  context.close = async () => { closes++; context.emit('close'); };
  const runtime = require('../src/native-runtime');
  mock.method(runtime, 'launchNative', async options => { options.onContext(context); return context; });
  const store = new ProfileStore(dir), manager = new BrowserManager(store, null, null, { startPage: false });
  try {
    const profile = store.create({ fingerprintMode: 'kernel', gpuPreset: 'native' });
    await manager.open(profile.id, { headless: true });
    pages = []; page.emit('close'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(closes, 0); assert.equal(manager.sessions.has(profile.id), true);
    context.emit('close'); assert.equal(manager.sessions.has(profile.id), false);
  } finally { mock.restoreAll(); await manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('local diagnostics classify the supplied log without saving credentials, URLs, tokens or argv', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-diagnostics-'));
  try {
    const error = new Error('Target crashed https://secret.invalid/private socks5://u:secret@host:1080 -profile C:\\Users\\Private\\profile\nRenderCompositorSWGL failed mapping default framebuffer, no dt\nredeclaration of let SimpleChannel');
    const file = recordFailure(dir, 'p_123456789abc', dir, { event: 'launch-failed', mode: 'software', error });
    const text = fs.readFileSync(file, 'utf8'), report = JSON.parse(text);
    assert.equal(report.flags.targetCrashed, true); assert.equal(report.flags.softwareFramebufferFailed, true);
    assert.equal(report.flags.jugglerChannelRedeclared, true); assert.equal(report.flags.gpuProcessFailed, false);
    assert.doesNotMatch(text, /secret|Private|profile C:|-profile/);
    assert.equal(failureDetails('ordinary shutdown').targetCrashed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
