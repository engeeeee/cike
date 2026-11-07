'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadChromium, chromiumStatus } = require('../electron/chromium');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');

test('Windows downloads and verifies Chromium, opens isolated profiles and preserves data',
  { skip: process.platform !== 'win32', timeout: 600000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cike Windows 测试-'));
    const previous = process.env.LFB_CHROMIUM_EXECUTABLE;
    let manager;
    try {
      const executable = await downloadChromium(root);
      const status = await chromiumStatus(root);
      assert.equal(status.installed, true);
      assert.equal(status.version, status.targetVersion);
      assert.equal(status.executable, executable);
      assert.equal(await downloadChromium(root), executable);
      process.env.LFB_CHROMIUM_EXECUTABLE = executable;
      const store = new ProfileStore(root);
      manager = new BrowserManager(store, null, null, { startPage: false, downloadsDirectory: path.join(root, '下载') });
      const a = store.create({}), b = store.create({});
      await manager.open(a.id, { headless: true });
      // An explicit expiry makes this a persistent cookie. Session cookies
      // added without visiting a site need not survive a browser restart.
      await manager.getContext(a.id).addCookies([{ name: 'fixture', value: 'saved', url: 'https://example.com',
        expires: Math.floor(Date.now() / 1000) + 86400 }]);
      assert.equal((await manager.getContext(a.id).cookies())[0]?.value, 'saved');
      await manager.open(b.id, { headless: true });
      assert.deepEqual(await manager.getContext(b.id).cookies(), []);
      await manager.close(a.id);
      assert.equal(manager.isOpen(b.id), true);
      await manager.open(a.id, { headless: true });
      assert.equal((await manager.getContext(a.id).cookies()).find(cookie => cookie.name === 'fixture')?.value, 'saved');
    } finally {
      await manager?.closeAll();
      if (previous === undefined) delete process.env.LFB_CHROMIUM_EXECUTABLE;
      else process.env.LFB_CHROMIUM_EXECUTABLE = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
