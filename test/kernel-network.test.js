'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
test('native core routes localhost through the selected proxy, has no direct fallback, and restricts STUN',
  { skip: !process.env.CIKE_CAMOUFOX_EXECUTABLE, timeout: 60000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-kernel-network-'));
    let direct = 0, packets = 0, proxyClosed = false;
    const target = http.createServer((request, response) => { direct++; response.end('direct'); }); await listen(target);
    const proxy = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html>native-proxy-fixture'); });
    proxy.on('connect', (request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }); await listen(proxy);
    const udp = dgram.createSocket('udp4'); await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve)); udp.on('message', () => packets++);
    const store = new ProfileStore(directory), manager = new BrowserManager(store, null, null, { startPage: false, checkProxy: async () => ({ status: 'ok', exitIp: '192.0.2.1' }) });
    try {
      const profile = store.create({ fingerprintMode: 'kernel', gpuPreset: 'native', locale: 'en-US', timezone: 'UTC', webrtc: 'default', proxy: { server: `http://127.0.0.1:${proxy.address().port}` } });
      await manager.open(profile.id, { headless: true });
      const page = manager.getContext(profile.id).pages()[0], url = `http://127.0.0.1:${target.address().port}`;
      await page.goto(url); assert.equal(await page.locator('body').innerText(), 'native-proxy-fixture'); assert.equal(direct, 0);
      await page.evaluate(async port => {
        const connection = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
        connection.createDataChannel('probe'); await connection.setLocalDescription(await connection.createOffer());
        await new Promise(resolve => setTimeout(resolve, 1500)); connection.close();
      }, udp.address().port);
      assert.equal(packets, 0);
      await close(proxy); proxyClosed = true;
      await assert.rejects(page.goto(url + '/closed', { timeout: 6000 }), /NS_ERROR|PROXY|CONNECTION|ERR_/);
      assert.equal(direct, 0);
    } finally { await manager.closeAll(); if (!proxyClosed) await close(proxy); await close(target); udp.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
