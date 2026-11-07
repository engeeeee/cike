'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('../src/settings');

test('window preferences migrate existing network settings and persist independently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-window-settings-'));
  try {
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ socksViaSystemProxy: true }));
    const settings = new Settings(root);
    assert.deepEqual(settings.get(), { socksViaSystemProxy: true, browserWindowMode: 'remember', browserWindowState: 'maximized' });
    settings.rememberWindowState('fullscreen');
    settings.set({ socksViaSystemProxy: false });
    assert.equal(new Settings(root).get().browserWindowState, 'fullscreen');
    settings.set({ browserWindowMode: 'maximized' });
    settings.rememberWindowState('normal');
    assert.equal(settings.get().browserWindowState, 'fullscreen');
    assert.equal(settings.get().socksViaSystemProxy, false);
    assert.throws(() => settings.set({ browserWindowMode: 'invalid' }), /窗口模式/);
    assert.equal(new Settings(root).get().browserWindowMode, 'maximized');
    settings.set({ browserWindowMode: 'remember' });
    settings.rememberWindowState('minimized');
    assert.equal(settings.get().browserWindowState, 'fullscreen');
    settings.rememberWindowState('normal');
    assert.equal(new Settings(root).get().browserWindowState, 'normal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
