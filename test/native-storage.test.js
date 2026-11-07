'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NativeStorage, binary } = require('../src/native-storage');
const { BUILD, nativeMarker } = require('../src/nativecore');
const { BrowserManager } = require('../src/browser');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-storage-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'), environment = {};
  const storage = new NativeStorage(data, { environment, verify: async executable => {
    assert.equal(fs.readFileSync(executable, 'utf8'), 'browser-fixture');
    assert.equal(fs.readFileSync(path.join(path.dirname(executable), 'resources', '中文.txt'), 'utf8'), 'preserved-bytes');
  } });
  const profiles = path.join(data, 'profiles', 'profile', 'firefox');
  fs.mkdirSync(profiles, { recursive: true });
  const cookie = path.join(profiles, 'cookies.sqlite'); fs.writeFileSync(cookie, 'login-fixture');
  function bundle(parent = storage.defaultRoot, suffix = 'abc123') {
    const directory = path.join(parent, `camoufox-${BUILD}-${suffix}`);
    fs.mkdirSync(path.join(directory, 'resources', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(directory, binary), 'browser-fixture');
    fs.writeFileSync(path.join(directory, 'application.ini'), `[App]\nVersion=${BUILD}\n`);
    fs.writeFileSync(path.join(directory, 'resources', '中文.txt'), 'preserved-bytes');
    return directory;
  }
  return { dir, data, environment, storage, cookie, bundle };
}

test('adopts existing dedicated installs, migrates with verification, keeps profiles and safely deletes the old copy', async t => {
  const f = fixture(t), source = f.bundle(); f.storage.select(path.join(source, binary));
  const status = await f.storage.status(); assert.equal(status.entries.length, 1); assert.equal(status.entries[0].current, true);
  assert.ok(status.entries[0].bytes > 0);
  f.environment.CIKE_CAMOUFOX_EXECUTABLE = path.join(source, binary);
  const target = path.join(f.dir, '其他磁盘 new root'); fs.mkdirSync(target);
  const unrelated = path.join(target, 'my-file.txt'); fs.writeFileSync(unrelated, 'keep-me');
  const mode = fs.statSync(target).mode, progress = [];
  const result = await f.storage.changeRoot(target, value => progress.push(value.pct));
  assert.equal(result.moved, true); assert.equal(fs.statSync(target).mode, mode);
  assert.equal(f.storage.root(), fs.realpathSync(target));
  assert.equal(f.environment.CIKE_CAMOUFOX_EXECUTABLE, result.executable);
  assert.equal(f.storage.markerValue(), result.executable);
  assert.ok(fs.existsSync(path.join(path.dirname(result.executable), 'resources', 'empty')));
  assert.ok(fs.existsSync(path.join(source, binary))); assert.equal(progress.at(-1), 100);
  const current = (await f.storage.status()).entries.find(entry => entry.current);
  assert.equal(current.bytes, status.entries[0].bytes);
  await f.storage.remove(result.previous);
  assert.ok(!fs.existsSync(source)); assert.ok(fs.existsSync(result.executable));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep-me');
  assert.equal(fs.readFileSync(f.cookie, 'utf8'), 'login-fixture');
});

test('failed startup validation rolls back the marker, directory and environment without touching old files', async t => {
  const f = fixture(t), source = f.bundle(); f.storage.select(path.join(source, binary));
  f.environment.CIKE_CAMOUFOX_EXECUTABLE = path.join(source, binary);
  f.storage.verify = async () => { throw new Error('probe-failed'); };
  const root = path.join(f.dir, 'failed-root');
  await assert.rejects(f.storage.changeRoot(root), /probe-failed/);
  assert.equal(f.storage.root(), fs.realpathSync(f.storage.defaultRoot));
  assert.equal(f.storage.markerValue(), path.join(source, binary));
  assert.equal(f.environment.CIKE_CAMOUFOX_EXECUTABLE, path.join(source, binary));
  assert.deepEqual(fs.readdirSync(root), []); assert.ok(fs.existsSync(path.join(source, binary)));
  assert.equal(fs.readFileSync(f.cookie, 'utf8'), 'login-fixture');
});

test('a transient Windows sharing violation after the startup probe is retried before switching locations', async t => {
  const f = fixture(t), source = f.bundle(); f.storage.select(path.join(source, binary));
  const rename = fs.promises.rename; let failures = 0;
  fs.promises.rename = async (from, to) => {
    if (path.basename(from).startsWith('camoufox-copy-') && failures++ === 0) throw Object.assign(new Error('transient-sharing-violation'), { code: 'EPERM' });
    return rename(from, to);
  };
  try {
    const result = await f.storage.changeRoot(path.join(f.dir, 'retry-target'));
    assert.equal(result.moved, true); assert.equal(f.storage.markerValue(), result.executable);
    assert.ok(fs.existsSync(path.join(source, binary)));
    assert.equal(fs.readFileSync(f.cookie, 'utf8'), 'login-fixture');
    assert.equal(failures, 2);
  } finally { fs.promises.rename = rename; }
});

test('rejects profile directories, self-copying paths and links resolving into profiles', async t => {
  const f = fixture(t), source = f.bundle(); await f.storage.status();
  assert.throws(() => f.storage.validateRoot(path.dirname(f.cookie)), /环境数据/);
  assert.throws(() => f.storage.validateRoot(path.join(source, 'nested')), /自身/);
  const alias = path.join(f.dir, 'alias'); fs.symlinkSync(path.join(f.data, 'profiles'), alias, 'junction');
  assert.throws(() => f.storage.validateRoot(path.join(alias, 'another')), /环境数据/);
  const entry = f.storage.load().entries[0];
  f.storage.save({ ...f.storage.load(), entries: [{ ...entry, directory: f.data }] });
  await assert.rejects(f.storage.remove(entry.id), /数据或环境目录/);
  assert.equal(fs.readFileSync(f.cookie, 'utf8'), 'login-fixture');
});

test('external kernels are read-only and changing root only affects later downloads', async t => {
  const f = fixture(t), external = f.bundle(path.join(f.dir, 'external'));
  f.environment.CIKE_CAMOUFOX_EXECUTABLE = path.join(external, binary);
  const status = await f.storage.status(); assert.equal(status.external, true); assert.deepEqual(status.entries, []);
  await assert.rejects(f.storage.remove('f'.repeat(32)), /不存在/);
  const result = await f.storage.changeRoot(path.join(f.dir, 'future'));
  assert.equal(result.moved, false); assert.equal(result.external, true);
  assert.ok(fs.existsSync(path.join(external, binary)));
  assert.equal(f.environment.CIKE_CAMOUFOX_EXECUTABLE, path.join(external, binary));
});

test('switches to a validated fallback before removing the active kernel; final uninstall preserves all profile data', async t => {
  const f = fixture(t), first = f.bundle(), second = f.bundle(f.storage.defaultRoot, 'def456');
  f.storage.select(path.join(first, binary));
  const entries = (await f.storage.status()).entries;
  const active = entries.find(entry => entry.current), spare = entries.find(entry => !entry.current);
  const plan = await f.storage.deletionPlan(active.id); assert.equal(plan.needsDownload, false); assert.equal(plan.fallback.id, spare.id);
  await f.storage.remove(active.id);
  assert.equal(f.storage.markerValue(), path.join(second, binary)); assert.ok(!fs.existsSync(first));
  assert.equal((await f.storage.deletionPlan(spare.id)).needsDownload, true);
  const result = await f.storage.remove(spare.id); assert.equal(result.needsDownload, true);
  assert.equal(f.storage.markerValue(), ''); assert.ok(!fs.existsSync(nativeMarker(f.data)));
  assert.equal(fs.readFileSync(f.cookie, 'utf8'), 'login-fixture');
});

test('an incompatible or unlaunchable spare is not silently selected', async t => {
  const f = fixture(t), first = f.bundle(); f.bundle(f.storage.defaultRoot, 'def456');
  f.storage.select(path.join(first, binary));
  f.storage.verify = async () => { throw new Error('broken-spare'); };
  const active = (await f.storage.status()).entries.find(entry => entry.current);
  assert.equal((await f.storage.deletionPlan(active.id)).needsDownload, true);
  await f.storage.remove(active.id); assert.equal(f.storage.markerValue(), '');
});

test('ownership failures never delete files; a missing directory can have its stale record removed', async t => {
  const f = fixture(t), directory = f.bundle();
  const entry = (await f.storage.status()).entries[0];
  fs.writeFileSync(path.join(directory, '.cike-camoufox.json'), '{}');
  await assert.rejects(f.storage.remove(entry.id), /归属/); assert.ok(fs.existsSync(path.join(directory, binary)));
  fs.rmSync(directory, { recursive: true }); await f.storage.remove(entry.id);
  assert.deepEqual((await f.storage.status()).entries, []);
});

test('a file lock leaves a tracked, safely retryable cleanup instead of a dangling active marker', async t => {
  const f = fixture(t), directory = f.bundle(); f.storage.select(path.join(directory, binary));
  const entry = (await f.storage.status()).entries[0], remove = fs.promises.rm;
  fs.promises.rm = async (filename, options) => {
    if (filename.includes('camoufox-delete-')) throw Object.assign(new Error('locked-fixture'), { code: 'EBUSY' });
    return remove(filename, options);
  };
  try { await assert.rejects(f.storage.remove(entry.id), /仍被占用/); }
  finally { fs.promises.rm = remove; }
  assert.equal(f.storage.markerValue(), '');
  const pending = (await f.storage.status()).entries[0]; assert.equal(pending.state, 'deleting'); assert.equal(pending.owned, true);
  await f.storage.remove(entry.id); assert.deepEqual((await f.storage.status()).entries, []);
  assert.equal(fs.readFileSync(f.cookie, 'utf8'), 'login-fixture');
});

test('deleting a marker-selected copy does not change an unrelated external override', async t => {
  const f = fixture(t), directory = f.bundle(), external = f.bundle(path.join(f.dir, 'external'));
  f.storage.select(path.join(directory, binary)); f.environment.CIKE_CAMOUFOX_EXECUTABLE = path.join(external, binary);
  const entry = (await f.storage.status()).entries[0]; assert.equal(entry.selected, true); assert.equal(entry.current, false);
  await f.storage.remove(entry.id);
  assert.equal(f.storage.markerValue(), ''); assert.equal(f.environment.CIKE_CAMOUFOX_EXECUTABLE, path.join(external, binary));
});

test('kernel maintenance rejects running/starting/closing environments and blocks API opens until completion', async () => {
  const manager = new BrowserManager({});
  for (const name of ['sessions', 'opening', 'closing']) {
    manager[name].set('fixture', {});
    await assert.rejects(manager.manageKernel(() => assert.fail('must not mutate files')), /关闭所有/);
    manager[name].clear();
  }
  let finish; const work = manager.manageKernel(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(manager.open('fixture'), error => error.status === 409);
  await assert.rejects(manager.manageKernel(() => {}), /正在进行/);
  finish('done'); assert.equal(await work, 'done'); assert.equal(manager.kernelMaintenance, false);
  await assert.rejects(manager.manageKernel(() => { throw new Error('failed-operation'); }), /failed-operation/);
  assert.equal(await manager.manageKernel(() => 'recovered'), 'recovered');
});
