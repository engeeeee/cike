'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchWithGraphics, isGraphicsLaunchCrash, graphicsPreferences } = require('../src/native-graphics');
const { Settings } = require('../src/settings');
const reportedCrash = 'browserType.launchPersistentContext: Target crashed\nFailed to launch GPU process after 3 attempts\n[D3D11] failed to get compositor device.\nFailed to initialize CompositorD3D11 for SWGL: FEATURE_FAILURE_D3D11_NO_DEVICE';

test('only a known Windows graphics launch crash receives one software retry', async () => {
  const calls = [], context = {}, profile = {}, proxy = { server: 'http://127.0.0.1:12345' };
  let checked = 0;
  const result = await launchWithGraphics(async mode => {
    calls.push({ mode, profile, proxy }); if (mode === 'hardware') throw new Error(reportedCrash); return context;
  }, { platform: 'win32', beforeRetry: () => checked++ });
  assert.deepEqual(calls.map(call => call.mode), ['hardware', 'software']);
  assert.ok(calls.every(call => call.profile === profile && call.proxy === proxy));
  assert.equal(result.context, context); assert.equal(result.graphicsFallback, true); assert.equal(checked, 1);
  for (const error of [new Error('Target crashed'), new Error('proxy authentication failed'), new Error('FEATURE_FAILURE_D3D11_NO_DEVICE without browser crash')]) {
    let attempts = 0;
    await assert.rejects(launchWithGraphics(async () => { attempts++; throw error; }, { platform: 'win32' }), reason => reason === error);
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(launchWithGraphics(async () => { attempts++; throw new Error(reportedCrash); }, { mode: 'hardware', platform: 'win32' }), /Target crashed/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(launchWithGraphics(async () => { attempts++; throw new Error(reportedCrash); }, { platform: 'win32' }), /Target crashed/);
  assert.equal(attempts, 2);
  assert.equal(isGraphicsLaunchCrash(new Error(reportedCrash)), true);
});

test('remembered compatibility skips the failing GPU launch, while cancellation prevents a retry', async () => {
  const calls = [];
  const result = await launchWithGraphics(async mode => { calls.push(mode); return {}; }, { remembered: true, platform: 'win32' });
  assert.deepEqual(calls, ['software']); assert.equal(result.graphicsFallback, false);
  let attempts = 0;
  await assert.rejects(launchWithGraphics(async () => { attempts++; throw new Error(reportedCrash); }, {
    platform: 'win32', beforeRetry: () => { throw new Error('cancelled'); },
  }), /cancelled/); assert.equal(attempts, 1);
  const prefs = graphicsPreferences('software', 'win32');
  assert.equal(prefs['gfx.webrender.software'], true);
  assert.equal(prefs['gfx.webrender.software.d3d11'], false);
  assert.equal(prefs['layers.gpu-process.enabled'], false);
  assert.ok(!Object.keys(prefs).some(name => /sandbox|proxy|webgl\.disabled/.test(name)));
});

test('graphics choices persist independently and a new choice clears remembered fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-graphics-settings-'));
  try {
    const settings = new Settings(dir); settings.rememberWindowState('fullscreen');
    settings.set({ socksViaSystemProxy: true }); settings.rememberCamoufoxSoftware();
    assert.equal(new Settings(dir).get().camoufoxAutoSoftware, true);
    settings.set({ camoufoxGraphicsMode: 'hardware' }); settings.rememberCamoufoxSoftware();
    const saved = new Settings(dir).get();
    assert.equal(saved.camoufoxAutoSoftware, false); assert.equal(saved.camoufoxGraphicsMode, 'hardware');
    assert.equal(saved.socksViaSystemProxy, true); assert.equal(saved.browserWindowState, 'fullscreen');
    settings.set({ camoufoxGraphicsMode: 'software' });
    assert.equal(new Settings(dir).get().camoufoxGraphicsMode, 'software');
    assert.throws(() => settings.set({ camoufoxGraphicsMode: '__proto__' }), /图形渲染/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
