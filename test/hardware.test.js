'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProfileStore } = require('../src/store');
const { generateHardware, hardwareOptions } = require('../src/hardware');

test('hardware settings have stable per-profile seeds and preserve explicit choices on edits and restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-hardware-store-'));
  try {
    const store = new ProfileStore(dir);
    const a = store.create({ fingerprintMode: 'hardware', hardwareConcurrency: 4, deviceMemory: 4, canvasNoise: false, audioNoise: false, gpuPreset: 'native' });
    const b = store.create({ fingerprintMode: 'hardware' });
    assert.notEqual(a.fingerprintSeed, b.fingerprintSeed);
    assert.equal(a.fingerprintSeed.length, 32);
    const updated = store.update(a.id, { name: 'renamed' });
    assert.equal(updated.fingerprintSeed, a.fingerprintSeed);
    assert.equal(updated.canvasNoise, false);
    assert.equal(updated.audioNoise, false);
    assert.equal(updated.gpuPreset, 'native');
    assert.equal(new ProfileStore(dir).get(a.id).fingerprintSeed, a.fingerprintSeed);
    assert.throws(() => store.update(a.id, { hardwareConcurrency: -1 }), /CPU/);
    assert.throws(() => store.update(a.id, { deviceMemory: 16 }), /内存/);
    assert.throws(() => store.update(a.id, { gpuPreset: '__proto__' }), /显卡/);
    assert.throws(() => store.update(a.id, { fingerprintSeed: 'bad' }), /种子/);
    assert.throws(() => store.update(a.id, { fingerprintMode: 'legacy' }), /转换/);
    assert.throws(() => store.create({ hardwareConcurrency: 4 }), /原生一致/);
    const generated = generateHardware();
    assert.ok(hardwareOptions().cpus.includes(generated.hardwareConcurrency));
    assert.equal(store.create(generated).fingerprintSeed, generated.fingerprintSeed);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
