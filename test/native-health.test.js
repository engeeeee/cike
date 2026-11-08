'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BUILD } = require('../src/nativecore');
const { verifyNativeExecutable } = require('../electron/nativecore');
test('kernel verification rejects a live browser whose content process cannot start, closes it and never opens an external page', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-health-test-'));
  fs.writeFileSync(path.join(directory, 'application.ini'), 'Version=' + BUILD + '\n');
  const executable = path.join(directory, 'fixture');
  let closed = 0, attempts = 0, failure = true, options;
  const browser = { close: async () => { closed++; }, newContext: async () => ({ setDefaultTimeout() {}, newPage: async () => {
    attempts++; if (failure) throw new Error('Target crashed');
    return { goto: async url => assert.match(url, /^data:text\/html,/), evaluate: async () => true };
  } }) };
  mock.method(require('playwright-native').firefox, 'launch', async value => { options = value; return browser; });
  try {
    await assert.rejects(verifyNativeExecutable(executable), /Target crashed/);
    assert.equal(closed, 1); assert.equal(attempts, 1);
    failure = false; attempts = 0; await verifyNativeExecutable(executable);
    assert.equal(attempts, 2); assert.equal(closed, 2);
    assert.equal(options.proxy.server, 'http://127.0.0.1:9');
    assert.equal(options.firefoxUserPrefs['network.proxy.type'], 1);
    assert.equal(options.firefoxUserPrefs['network.proxy.no_proxies_on'], '');
    assert.ok(!Object.keys(options).some(name => /sandbox/i.test(name)));
    fs.writeFileSync(path.join(directory, 'application.ini'), 'Version=wrong\n');
    await assert.rejects(verifyNativeExecutable(executable), /版本不匹配/); assert.equal(closed, 2);
  } finally { mock.restoreAll(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('the real pinned core must create and paint two content pages before it passes verification',
  { skip: !process.env.CIKE_CAMOUFOX_EXECUTABLE, timeout: 60000 }, async () => {
    await verifyNativeExecutable(process.env.CIKE_CAMOUFOX_EXECUTABLE);
  });
