'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { NativeStorage, binary } = require('../src/native-storage');
const { BUILD } = require('../src/nativecore');
const { verifyNativeExecutable } = require('../electron/nativecore');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');

test('real kernel migrates across storage roots, reopens the same login data and survives deletion of the old copy',
  { skip: !process.env.CIKE_CAMOUFOX_EXECUTABLE, timeout: 600000 }, async () => {
    const original = process.env.CIKE_CAMOUFOX_EXECUTABLE;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-storage-real-'));
    const targetParent = process.env.RUNNER_TEMP || path.dirname(dir);
    const target = fs.mkdtempSync(path.join(targetParent, 'cike-内核 storage-'));
    const storage = new NativeStorage(dir, { verify: verifyNativeExecutable });
    const source = path.join(storage.defaultRoot, `camoufox-${BUILD}-abc123`);
    const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Storage fixture</title>'); });
    const profiles = new ProfileStore(dir), manager = new BrowserManager(profiles, null, null, { startPage: false });
    try {
      // Clone only this test's bundle. Hard links avoid duplicating the CI
      // download; omit the owner marker so adoption cannot modify shared metadata.
      function clone(from, to) {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
          if (entry.name === '.cike-camoufox.json') continue;
          const a = path.join(from, entry.name), b = path.join(to, entry.name);
          if (entry.isDirectory()) clone(a, b);
          else if (entry.isFile()) { try { fs.linkSync(a, b); } catch (error) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(a, b); } }
          else throw new Error('Unexpected link in CI kernel fixture');
        }
      }
      clone(path.dirname(original), source);
      process.env.CIKE_CAMOUFOX_EXECUTABLE = path.join(source, binary);
      storage.select(path.join(source, binary));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const profile = profiles.create({ fingerprintMode: 'kernel', hardwareConcurrency: 4, gpuPreset: 'native' });
      await manager.open(profile.id, { headless: true });
      let page = await manager.getContext(profile.id).newPage(); await page.goto(origin);
      await page.evaluate(() => { document.cookie = 'storage=login; path=/; max-age=3600'; localStorage.setItem('storage', 'retained'); });
      await assert.rejects(manager.manageKernel(() => storage.changeRoot(target)), /关闭所有/);
      await manager.closeAll();
      const result = await manager.manageKernel(() => storage.changeRoot(target));
      assert.equal(result.moved, true); assert.ok(result.executable.startsWith(target + path.sep));
      assert.equal(process.env.CIKE_CAMOUFOX_EXECUTABLE, result.executable);
      assert.ok(fs.existsSync(path.join(source, binary)));
      await manager.manageKernel(() => storage.remove(result.previous));
      assert.ok(!fs.existsSync(source)); assert.ok(fs.existsSync(original));
      await manager.open(profile.id, { headless: true });
      page = await manager.getContext(profile.id).newPage(); await page.goto(origin);
      assert.deepEqual(await page.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem('storage'), cpu: navigator.hardwareConcurrency })),
        { cookie: 'storage=login', local: 'retained', cpu: 4 });
      await manager.closeAll();
      const active = (await storage.status()).entries.find(entry => entry.current);
      assert.equal((await manager.manageKernel(() => storage.remove(active.id))).needsDownload, true);
      assert.ok(fs.existsSync(path.join(profiles.profileDir(profile.id), 'firefox', 'cookies.sqlite')));
      assert.ok(fs.existsSync(original));
      console.log('Verified native kernel migration, old-copy cleanup and persisted login data:', result.root);
    } finally {
      await manager.closeAll(); process.env.CIKE_CAMOUFOX_EXECUTABLE = original;
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true });
    }
  });
