'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');
const { GPU_PRESETS } = require('../src/hardware');

async function observe() {
  const hash = data => { let value = 2166136261; for (const n of data) value = Math.imul(value ^ n, 16777619); return value >>> 0; };
  const canvas = new OffscreenCanvas(64, 64), context = canvas.getContext('2d');
  context.fillStyle = 'rgb(120,180,200)'; context.fillRect(0, 0, 64, 64);
  const a = hash(context.getImageData(0, 0, 64, 64).data), b = hash(context.getImageData(0, 0, 64, 64).data);
  const blob = await canvas.convertToBlob(); const bitmap = await createImageBitmap(blob);
  const copy = new OffscreenCanvas(64, 64), copied = copy.getContext('2d'); copied.drawImage(bitmap, 0, 0); bitmap.close();
  const gpuCanvas = new OffscreenCanvas(64, 64), gl = gpuCanvas.getContext('webgl');
  let gpu = null, gpuPixels = null;
  if (gl) {
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    if (extension) gpu = { vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) };
    gl.clearColor(120 / 255, 180 / 255, 200 / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const rgba = new Uint8Array(64 * 64 * 4); gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const flipped = new Uint8Array(rgba.length);
    for (let row = 0; row < 64; row++) flipped.set(rgba.subarray(row * 256, (row + 1) * 256), (63 - row) * 256);
    gpuPixels = hash(flipped);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  const headers = await fetch(location.origin + '/headers').then(response => response.json());
  return { cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
    canvas: a, repeated: b, exported: hash(copied.getImageData(0, 0, 64, 64).data), gpu, gpuPixels,
    memoryHeader: headers['device-memory'], memoryHint: headers['sec-ch-device-memory'] };
}
async function audioValues() {
  const context = new OfflineAudioContext(1, 4096, 44100), oscillator = context.createOscillator(); oscillator.connect(context.destination); oscillator.start();
  const buffer = await context.startRendering(), first = Array.from(buffer.getChannelData(0)), second = Array.from(buffer.getChannelData(0)), copied = new Float32Array(buffer.length); buffer.copyFromChannel(copied, 0);
  return { first, second, copied: Array.from(copied) };
}

test('hardware simulation agrees at first script execution across pages, frames and all worker types, and survives restart', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-hardware-runtime-'));
  const source = `(${observe.toString()})()`;
  const server = http.createServer((request, response) => {
    response.setHeader('Accept-CH', 'Device-Memory, Sec-CH-Device-Memory');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self' blob:");
    if (request.url === '/headers') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers)); }
    else if (request.url === '/worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`const first=${source};first.then(value=>postMessage(value));`); }
    else if (request.url === '/shared.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`const first=${source};onconnect=e=>first.then(value=>e.ports[0].postMessage(value));`); }
    else if (request.url === '/sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`const first=${source};self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>first.then(value=>e.ports[0].postMessage(value)));`); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><iframe src="/frame"></iframe>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const store = new ProfileStore(dir), manager = new BrowserManager(store, null, null, { startPage: false, downloadsDirectory: path.join(dir, 'Downloads') });
  try {
    const a = store.create({ fingerprintMode: 'hardware', hardwareConcurrency: 4, deviceMemory: 4, gpuPreset: 'intel-uhd-630', fingerprintSeed: '1234567890abcdef1234567890abcdef', locale: 'en-US', timezone: 'UTC' });
    const b = store.create({ fingerprintMode: 'hardware', hardwareConcurrency: 16, deviceMemory: 8, gpuPreset: 'nvidia-rtx-3060', fingerprintSeed: 'fedcba0987654321fedcba0987654321' });
    await manager.open(a.id, { headless: true });
    const context = manager.getContext(a.id), page = await context.newPage(); await page.goto(origin);
    const main = await page.evaluate(observe);
    assert.equal(main.cores, 4); assert.equal(main.memory, 4);
    assert.equal(main.canvas, main.repeated); assert.equal(main.canvas, main.exported);
    if (main.gpuPixels !== null) assert.equal(main.gpuPixels, main.canvas);
    assert.equal(main.memoryHeader, '4'); assert.equal(main.memoryHint, '4');
    if (main.gpu) assert.equal(main.gpu.renderer, GPU_PRESETS[a.gpuPreset].renderer);
    assert.deepEqual(await page.frames()[1].evaluate(observe), main);
    for (const type of ['classic', 'module']) {
      const worker = await page.evaluate(type => new Promise((resolve, reject) => { const w = new Worker('/worker.js', { type }); w.onmessage = e => { w.terminate(); resolve(e.data); }; w.onerror = reject; }), type);
      assert.deepEqual(worker, main);
    }
    const shared = await page.evaluate(() => new Promise((resolve, reject) => { const w = new SharedWorker('/shared.js'); w.port.onmessage = e => { w.port.close(); resolve(e.data); }; w.onerror = reject; }));
    assert.deepEqual(shared, main);
    const blobWorker = await page.evaluate(source => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([`const first=${source};first.then(value=>postMessage(value));`], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = event => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); }; worker.onerror = reject;
    }), source);
    assert.deepEqual(blobWorker, main);
    const nested = await page.evaluate(() => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([`const inner=new Worker(location.origin+'/worker.js');inner.onmessage=e=>{inner.terminate();postMessage(e.data)};`], { type: 'text/javascript' }));
      const worker = new Worker(url); worker.onmessage = e => { worker.terminate(); URL.revokeObjectURL(url); resolve(e.data); }; worker.onerror = reject;
    }));
    assert.deepEqual(nested, main);
    const service = await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); const reg = await navigator.serviceWorker.ready; return new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = e => resolve(e.data); reg.active.postMessage('probe', [channel.port2]); }); });
    assert.deepEqual(service, main);
    const audio = await page.evaluate(audioValues);
    assert.deepEqual(audio.first, audio.second); assert.deepEqual(audio.first, audio.copied);
    const htmlCanvas = await page.evaluate(async () => {
      const hash = data => { let value = 2166136261; for (const n of data) value = Math.imul(value ^ n, 16777619); return value >>> 0; };
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d'); context.fillStyle = 'rgb(120,180,200)'; context.fillRect(0, 0, 64, 64);
      const raw = hash(context.getImageData(0, 0, 64, 64).data);
      const fromBlob = async blob => { const image = await createImageBitmap(blob), copy = document.createElement('canvas'); copy.width = copy.height = 64; const c = copy.getContext('2d'); c.drawImage(image, 0, 0); image.close(); return hash(c.getImageData(0, 0, 64, 64).data); };
      const data = canvas.toDataURL(), blob = await new Promise(resolve => canvas.toBlob(resolve));
      const decoded = new Blob([Uint8Array.from(atob(data.split(',')[1]), character => character.charCodeAt(0))], { type: 'image/png' });
      return { raw, repeated: data === canvas.toDataURL(), blob: await fromBlob(blob), data: await fromBlob(decoded) };
    });
    assert.equal(htmlCanvas.raw, main.canvas); assert.equal(htmlCanvas.repeated, true); assert.equal(htmlCanvas.blob, htmlCanvas.raw); assert.equal(htmlCanvas.data, htmlCanvas.raw);
    const webgpu = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return adapter?.info ? { vendor: adapter.info.vendor, description: adapter.info.description } : null;
    });
    if (webgpu) { assert.equal(webgpu.vendor, GPU_PRESETS[a.gpuPreset].webgpuVendor); assert.equal(webgpu.description, GPU_PRESETS[a.gpuPreset].name); }
    await manager.open(b.id, { headless: true }); const pageB = await manager.getContext(b.id).newPage(); await pageB.goto(origin);
    const other = await pageB.evaluate(observe);
    assert.equal(other.cores, 16); assert.equal(other.memory, 8); assert.notEqual(other.canvas, main.canvas);
    assert.notDeepEqual((await pageB.evaluate(audioValues)).first, audio.first);
    if (other.gpu) assert.equal(other.gpu.renderer, GPU_PRESETS[b.gpuPreset].renderer);
    await manager.close(a.id); await manager.open(a.id, { headless: true });
    const again = await manager.getContext(a.id).newPage(); await again.goto(origin);
    assert.deepEqual(await again.evaluate(observe), main);
    assert.deepEqual((await again.evaluate(audioValues)).first, audio.first);
    const restartedService = await again.evaluate(async () => { const reg = await navigator.serviceWorker.ready; return new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = e => resolve(e.data); reg.active.postMessage('probe', [channel.port2]); }); });
    assert.deepEqual(restartedService, main);
    const native = store.create({}); await manager.open(native.id, { headless: true });
    assert.equal(await manager.getContext(native.id).pages()[0].evaluate(() => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'hardwareConcurrency').get.name), 'get hardwareConcurrency');
  } finally { await manager.closeAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
