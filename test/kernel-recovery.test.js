'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const core = require('../src/nativecore');
const { startBackend } = require('../src/server');
const { ownedBrowser } = require('../src/browser-lifecycle');
const enabled = !!process.env.CIKE_CAMOUFOX_EXECUTABLE && (process.platform === 'win32' || !!process.env.DISPLAY);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(read, predicate) {
  for (let n = 0; n < 150; n++) { const result = await read(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Native UI recovery verification timed out');
}

test('real Firefox new-tab/new-window commands remain usable in old and new profiles; hung protocol shutdown preserves login data',
  { skip: !enabled, timeout: 180000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-native-recovery-'));
    let command = 0, report = [], backend, direct = 0;
    const target = http.createServer((_request, response) => { direct++; response.end('must use proxy'); }); await listen(target);
    const fixtureURL = `http://127.0.0.1:${target.address().port}/native-ui`;
    const proxy = http.createServer((request, response) => {
      if (request.url.startsWith(`http://127.0.0.1:${control.address().port}/`)) {
        const relay = http.request(`http://127.0.0.1:${control.address().port}/`, { method: request.method, headers: request.headers }, upstream => {
          response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response);
        }); relay.on('error', () => response.end()); request.pipe(relay); return;
      }
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>native-ui-fixture</title><p>native-ui-fixture</p>');
    });
    proxy.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    await listen(proxy);
    const control = http.createServer(async (request, response) => {
      if (request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        report = JSON.parse(body); response.end('ok'); return;
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ command, url: fixtureURL }));
    }); await listen(control);
    const addon = path.join(dir, 'native-command-fixture'); fs.mkdirSync(addon);
    // Test-only privileged experiment invokes the same browser chrome commands
    // as Ctrl+T / Ctrl+N. Hosted runners cannot reliably foreground SendKeys.
    // No experiments or controller addon are installed in the shipped app.
    fs.writeFileSync(path.join(addon, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'Native UI test controller', version: '1.0',
      browser_specific_settings: { gecko: { id: 'native-ui-test@local.invalid' } }, permissions: ['tabs', 'http://127.0.0.1/*'],
      experiment_apis: { nativeUi: { schema: 'schema.json', parent: { scopes: ['addon_parent'], paths: [['nativeUi']], script: 'api.js' } } },
      background: { scripts: ['control.js'] } }));
    fs.writeFileSync(path.join(addon, 'schema.json'), JSON.stringify([{ namespace: 'nativeUi', functions: ['tab', 'window'].map(name => ({ name, type: 'function', async: true, parameters: [] })) }]));
    fs.writeFileSync(path.join(addon, 'api.js'), `var nativeUi=class extends ExtensionAPI{getAPI(){const {BrowserWindowTracker}=ChromeUtils.importESModule('resource:///modules/BrowserWindowTracker.sys.mjs');return {nativeUi:{async tab(){BrowserWindowTracker.getTopWindow().BrowserCommands.openTab();},async window(){BrowserWindowTracker.getTopWindow().OpenBrowserWindow();}}};}};`);
    fs.writeFileSync(path.join(addon, 'control.js'), `let done=0,busy=false;setInterval(async()=>{if(busy)return;busy=true;try{const c=await(await fetch('http://127.0.0.1:${control.address().port}')).json();if(c.command>done){done=c.command;if(done%2)await browser.nativeUi.tab();else await browser.nativeUi.window();}const tabs=await browser.tabs.query({});for(const tab of tabs)if(tab.url==='about:newtab'||tab.url==='about:blank'||tab.url==='chrome://browser/content/blanktab.html')await browser.tabs.update(tab.id,{url:c.url});await fetch('http://127.0.0.1:${control.address().port}',{method:'POST',body:JSON.stringify((await browser.tabs.query({})).map(t=>({id:t.id,url:t.url,title:t.title,status:t.status})))});}catch(error){console.error(error.message)}finally{busy=false}},200);`);
    const environment = core.nativeEnvironment;
    mock.method(core, 'nativeEnvironment', (config, preferences) => {
      (config.addons ||= []).push(addon); config.allowAddonNewtab = true;
      preferences['extensions.experiments.enabled'] = true;
      return environment(config, preferences);
    });
    try {
      backend = await startBackend(dir, { startPage: false, checkProxy: async () => ({ status: 'ok', exitIp: '192.0.2.1' }) });
      backend.settings.set({ camoufoxGraphicsMode: 'software' });
      const create = name => backend.store.create({ name, fingerprintMode: 'kernel', gpuPreset: 'native', locale: 'en-US', timezone: 'UTC',
        proxy: { server: `http://127.0.0.1:${proxy.address().port}` } });
      const old = create('old profile'), fresh = create('fresh profile'), manager = backend.browsers;
      // Seed genuine Firefox cookies, localStorage and prefs with this driver.
      await manager.open(old.id); let context = manager.getContext(old.id);
      await until(() => report, tabs => tabs.some(tab => tab.title === 'native-ui-fixture' && tab.status === 'complete'));
      let page = context.pages()[0]; await page.waitForURL(fixtureURL);
      await page.evaluate(() => { document.cookie = 'recovery=retained; path=/; max-age=3600'; localStorage.setItem('recovery', 'retained'); });
      await manager.closeAll();
      const firefox = path.join(backend.store.profileDir(old.id), 'firefox');
      fs.mkdirSync(path.join(firefox, 'startupCache'), { recursive: true }); fs.writeFileSync(path.join(firefox, 'startupCache/obsolete'), 'stale');
      fs.writeFileSync(path.join(firefox, '.cike-runtime.json'), JSON.stringify({ revision: 0, unclean: true }));
      fs.appendFileSync(path.join(firefox, 'user.js'), '\n// retained user setting\nuser_pref("browser.display.use_document_fonts", 1);\n');
      for (const profile of [old, fresh]) {
        command = 0; report = []; await manager.open(profile.id); context = manager.getContext(profile.id);
        let crashes = 0; context.on('page', opened => opened.on('crash', () => crashes++));
        for (let n = 1; n <= 4; n++) {
          command = n;
          await until(() => report, tabs => tabs.length >= n + 1 && tabs.every(tab => tab.title === 'native-ui-fixture' && tab.status === 'complete'));
          await until(() => context.pages(), pages => pages.length >= n + 1);
          for (const opened of context.pages()) assert.match(await opened.locator('body').innerText(), /native-ui-fixture/);
          assert.equal(manager.sessions.has(profile.id), true); assert.equal(crashes, 0);
        }
        if (profile === old) {
          page = context.pages()[0];
          assert.deepEqual(await page.evaluate(() => [document.cookie, localStorage.getItem('recovery')]), ['recovery=retained', 'retained']);
          assert.match(fs.readFileSync(path.join(firefox, 'user.js'), 'utf8'), /retained user setting/);
          assert.equal(fs.existsSync(path.join(firefox, 'startupCache/obsolete')), false);
          assert.ok(fs.readdirSync(path.join(firefox, 'cike-recovery')).length);
        }
        // A real browser process, with only its close protocol made unresponsive.
        const owner = ownedBrowser(context); assert.ok(owner?.process?.pid);
        const close = context.close; context.close = () => new Promise(() => {});
        const started = Date.now(); await manager.close(profile.id); context.close = close;
        assert.ok(Date.now() - started < 10000); assert.ok(owner.process.exitCode != null || owner.process.signalCode != null);
        assert.equal(manager.sessions.size, 0); assert.equal(manager.contexts.size, 0);
      }
      command = 0; report = []; await manager.open(old.id);
      await until(() => report, tabs => tabs.some(tab => tab.title === 'native-ui-fixture' && tab.status === 'complete'));
      assert.deepEqual(await manager.getContext(old.id).pages()[0].evaluate(() => [document.cookie, localStorage.getItem('recovery')]), ['recovery=retained', 'retained']);
      assert.equal(direct, 0);
    } finally {
      await backend?.browsers.closeAll(); if (backend) await new Promise(resolve => backend.server.close(resolve));
      mock.restoreAll();
      for (const server of [target, proxy, control]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('an actual Firefox content-process crash does not close its browser and produces an exportable local diagnosis',
  { skip: !enabled, timeout: 45000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-content-crash-'));
    const backend = await startBackend(dir, { startPage: false });
    backend.settings.set({ camoufoxGraphicsMode: 'software' });
    const profile = backend.store.create({ fingerprintMode: 'kernel', gpuPreset: 'native', locale: 'en-US', timezone: 'UTC' });
    try {
      await backend.browsers.open(profile.id, { headless: true });
      const context = backend.browsers.getContext(profile.id), page = context.pages()[0];
      const crash = page.waitForEvent('crash');
      // Firefox's intentional content-process crash test page, in a disposable
      // test profile only. Keep the real production sandbox settings.
      await assert.rejects(page.goto('about:crashcontent', { timeout: 10000 }), /crash/i); await crash;
      await until(() => context.pages(), pages => !pages.includes(page));
      assert.equal(backend.browsers.sessions.has(profile.id), true);
      const next = await context.newPage(); await next.goto('data:text/html,<title>recovered</title>still running');
      assert.equal(await next.title(), 'recovered');
      assert.equal(backend.browsers.crashes.has(profile.id), true);
      const file = path.join(dir, 'diagnostics', profile.id + '.json');
      const report = JSON.parse(fs.readFileSync(file));
      assert.equal(report.event, 'page-crash'); assert.equal(report.flags.targetCrashed, true);
      assert.equal(report.graphicsMode, 'software');
      await backend.browsers.closeAll();
      const state = JSON.parse(fs.readFileSync(path.join(backend.store.profileDir(profile.id), 'firefox', '.cike-runtime.json')));
      assert.equal(state.crashed, true);
    } finally {
      await backend.browsers.closeAll(); await new Promise(resolve => backend.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
