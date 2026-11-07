'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');

async function observe() {
  const native = fn => /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn)) && !Object.hasOwn(fn, 'prototype');
  const snapshot = { cores: navigator.hardwareConcurrency, memory: 'deviceMemory' in navigator,
    ua: navigator.userAgent, language: navigator.language, languages: [...navigator.languages],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cpuGetterNative: native(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'hardwareConcurrency').get) };
  const canvas = new OffscreenCanvas(16, 16), context = canvas.getContext('2d');
  context.fillStyle = 'rgb(30,160,90)'; context.fillRect(0, 0, 16, 16);
  snapshot.cleanPixels = context.getImageData(0, 0, 16, 16).data.every((n, i) => n === [30, 160, 90, 255][i % 4]);
  snapshot.canvasNative = native(Object.getPrototypeOf(context).getImageData);
  snapshot.headers = await fetch(location.origin + '/headers').then(response => response.json()).then(headers => ({ ua: headers['user-agent'], language: headers['accept-language']?.split(',')[0] }));
  return snapshot;
}
async function until(read, predicate) {
  for (let n = 0; n < 200; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Native core verification timed out');
}
async function audioProbe() {
  const native = fn => /\[native code\]/.test(Function.prototype.toString.call(fn));
  const context = new OfflineAudioContext(1, 1024, 44100), source = context.createConstantSource();
  source.offset.value = 0.25; source.connect(context.destination); source.start();
  const buffer = await context.startRendering();
  document.documentElement.dataset.audioResult = String(native(AudioBuffer.prototype.getChannelData) && native(HTMLCanvasElement.prototype.toDataURL) &&
    native(WebGLRenderingContext.prototype.getParameter) && buffer.getChannelData(0).every(value => value === 0.25));
}
test('native core changes hardware without replacing APIs, agrees across workers, persists data and keeps native downloads',
  { skip: !process.env.CIKE_CAMOUFOX_EXECUTABLE, timeout: 120000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-kernel-test-')), downloads = path.join(dir, 'Downloads');
    const source = `(${observe.toString()})()`;
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self' blob:");
      if (request.url === '/headers') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers)); }
      else if (request.url === '/file') { response.setHeader('Content-Disposition', 'attachment; filename="native-fixture.txt"'); response.end('native-download-fixture'); }
      else if (request.url === '/worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`const first=${source};first.then(postMessage);`); }
      else if (request.url === '/shared.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`const first=${source};onconnect=e=>first.then(value=>e.ports[0].postMessage(value));`); }
      else if (request.url === '/sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`const first=${source};self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>first.then(value=>e.ports[0].postMessage(value)));`); }
      else if (request.url === '/audio.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`(${audioProbe.toString()})()`); }
      else if (request.url === '/audio') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><script src="/audio.js"></script>'); }
      else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html>' + (request.url === '/' ? '<iframe src="/frame"></iframe>' : '')); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const store = new ProfileStore(dir), manager = new BrowserManager(store, null, null, { startPage: false, downloadsDirectory: downloads });
    try {
      const a = store.create({ fingerprintMode: 'kernel', hardwareConcurrency: 4, gpuPreset: 'native', locale: 'en-US', timezone: 'UTC' });
      const b = store.create({ fingerprintMode: 'kernel', hardwareConcurrency: 16, gpuPreset: 'native', locale: 'en-US', timezone: 'UTC' });
      await manager.open(a.id, { headless: true });
      const context = manager.getContext(a.id), page = await context.newPage(); await page.goto(origin);
      const main = await page.evaluate(observe);
      assert.equal(main.cores, 4); assert.equal(main.memory, false); assert.equal(main.cpuGetterNative, true);
      assert.equal(main.cleanPixels, true); assert.equal(main.canvasNative, true); assert.equal(main.timezone, 'UTC');
      assert.equal(main.language, 'en-US'); assert.equal(main.headers.language, main.language); assert.equal(main.headers.ua, main.ua);
      assert.deepEqual(await page.frames()[1].evaluate(observe), main);
      for (const type of ['classic', 'module']) {
        const value = await page.evaluate(type => new Promise((resolve, reject) => {
          const worker = new Worker('/worker.js', { type }); worker.onmessage = e => { worker.terminate(); resolve(e.data); }; worker.onerror = reject;
        }), type);
        assert.deepEqual(value, main);
      }
      const shared = await page.evaluate(() => new Promise((resolve, reject) => {
        const worker = new SharedWorker('/shared.js'); worker.port.onmessage = e => { worker.port.close(); resolve(e.data); }; worker.onerror = reject;
      }));
      assert.deepEqual(shared, main);
      const service = async () => page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js'); const registration = await navigator.serviceWorker.ready;
        return new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = e => resolve(e.data); registration.active.postMessage('probe', [channel.port2]); });
      });
      assert.deepEqual(await service(), main);
      // Camoufox isolates automation evaluation; run this probe as the site's
      // own first-party script, including the PCM TypedArray access.
      const audioPage = await context.newPage(); await audioPage.goto(origin + '/audio');
      await audioPage.waitForFunction(() => document.documentElement.dataset.audioResult !== undefined);
      assert.equal(await audioPage.evaluate(() => document.documentElement.dataset.audioResult), 'true'); await audioPage.close();
      await page.evaluate(() => { document.cookie = 'kernel=A; path=/; max-age=3600'; localStorage.setItem('kernel', 'A'); });
      for (let count = 1; count <= 2; count++) {
        await page.evaluate(() => { const link = document.createElement('a'); link.href = '/file'; document.body.append(link); link.click(); link.remove(); });
        await until(() => fs.readdirSync(downloads).filter(name => name.endsWith('.txt')), names => names.length === count);
      }
      for (const name of fs.readdirSync(downloads).filter(name => name.endsWith('.txt'))) assert.equal(fs.readFileSync(path.join(downloads, name), 'utf8'), 'native-download-fixture');
      await manager.open(b.id, { headless: true });
      const other = await manager.getContext(b.id).newPage(); await other.goto(origin);
      assert.equal(await other.evaluate(() => navigator.hardwareConcurrency), 16);
      assert.equal(await other.evaluate(() => localStorage.getItem('kernel')), null);
      await manager.close(a.id); await manager.open(a.id, { headless: true });
      const restarted = await manager.getContext(a.id).newPage(); await restarted.goto(origin);
      assert.deepEqual(await restarted.evaluate(observe), main);
      assert.deepEqual(await restarted.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem('kernel') })), { cookie: 'kernel=A', local: 'A' });
      assert.ok(fs.existsSync(path.join(store.profileDir(a.id), 'firefox', 'prefs.js')));
      assert.ok(!fs.existsSync(path.join(store.profileDir(a.id), 'Default')));
    } finally { await manager.closeAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
  });
