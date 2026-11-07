'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { ProfileStore } = require('../src/store');
const { BrowserManager } = require('../src/browser');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-native-site-'));
  const store = new ProfileStore(directory), manager = new BrowserManager(store, null, null, { startPage: false });
  try {
    const profile = store.create({ fingerprintMode: 'kernel', hardwareConcurrency: 4, gpuPreset: 'native' });
    await manager.open(profile.id, { headless: true });
    const page = manager.getContext(profile.id).pages()[0];
    await page.goto('https://who.1ms.dog/zh-cn/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait for the complete test, not an early green result before audio/lies.
    await page.waitForFunction(() => document.querySelector('#rerun')?.disabled === false && /st-(ok|bad|warn)/.test(document.querySelector('.ckr[data-c="tamper"]')?.className || ''), {}, { timeout: 90000 });
    const result = await page.evaluate(() => ({
      cores: navigator.hardwareConcurrency,
      checks: Object.fromEntries(['tamper', 'fpb', 'ua', 'bot'].map(key => {
        const row = document.querySelector('.ckr[data-c="' + key + '"]');
        return [key, { status: row?.className, text: row?.querySelector('.ck-v')?.textContent }];
      })),
    }));
    console.log(JSON.stringify({ platform: process.platform, core: 'Camoufox', ...result }, null, 2));
    assert.equal(result.cores, 4);
    assert.equal(result.checks.tamper.status, 'ckr st-ok', 'The requested detector still reports environment tampering');
  } finally { await manager.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
