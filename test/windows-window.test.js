'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');
const { Settings } = require('../src/settings');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function windowFor(context, page) {
  const session = await context.newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  return { session, windowId };
}
async function expectState(control, expected) {
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await control.session.send('Browser.getWindowBounds', { windowId: control.windowId })).bounds.windowState;
    if (state === expected) return;
    await delay(50);
  }
  assert.equal(state, expected);
}
async function changeState(control, state) {
  await control.session.send('Browser.setWindowBounds', { windowId: control.windowId, bounds: { windowState: state } });
  await expectState(control, state);
}
async function newWindow(context, control) {
  const opened = context.waitForEvent('page');
  await control.session.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  return windowFor(context, await opened);
}

test('Windows maximizes new profiles, inherits F11 fullscreen in new windows and remembers it after restart',
  { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-window-state-'));
    const store = new ProfileStore(root), settings = new Settings(root);
    let manager = new BrowserManager(store, null, settings, { startPage: false, downloadsDirectory: path.join(root, 'Downloads') });
    try {
      const a = store.create({ viewport: { width: 800, height: 600 } }), b = store.create({});
      await manager.open(a.id);
      const context = manager.getContext(a.id), page = context.pages()[0];
      assert.equal(page.viewportSize(), null);
      const first = await windowFor(context, page);
      await expectState(first, 'maximized');
      // Change native state without using CIKE's preference setter, as F11 does.
      await changeState(first, 'fullscreen');
      const popup = await newWindow(context, first);
      assert.notEqual(popup.windowId, first.windowId);
      await expectState(popup, 'fullscreen');
      const tab = await context.newPage();
      await expectState(await windowFor(context, tab), 'fullscreen');
      await manager.open(b.id);
      await expectState(await windowFor(manager.getContext(b.id), manager.getContext(b.id).pages()[0]), 'fullscreen');
      await manager.closeAll();
      assert.equal(new Settings(root).get().browserWindowState, 'fullscreen');
      manager = new BrowserManager(store, null, new Settings(root), { startPage: false, downloadsDirectory: path.join(root, 'Downloads') });
      await manager.open(a.id);
      await expectState(await windowFor(manager.getContext(a.id), manager.getContext(a.id).pages()[0]), 'fullscreen');
    } finally { await manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
  });

test('Windows respects explicit maximize/fullscreen preferences and remembers restoring a normal window',
  { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-window-modes-'));
    const store = new ProfileStore(root), settings = new Settings(root);
    const manager = new BrowserManager(store, null, settings, { startPage: false, downloadsDirectory: path.join(root, 'Downloads') });
    try {
      const a = store.create({}), b = store.create({});
      await manager.open(a.id);
      const context = manager.getContext(a.id), first = await windowFor(context, context.pages()[0]);
      await changeState(first, 'normal');
      await expectState(await newWindow(context, first), 'normal');
      settings.set({ browserWindowMode: 'maximized' });
      await manager.open(b.id);
      await expectState(await windowFor(manager.getContext(b.id), manager.getContext(b.id).pages()[0]), 'maximized');
      settings.set({ browserWindowMode: 'fullscreen' });
      await expectState(await newWindow(context, first), 'fullscreen');
      assert.equal(settings.get().socksViaSystemProxy, false);
    } finally { await manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
  });
