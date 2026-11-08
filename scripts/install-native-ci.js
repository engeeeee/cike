'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { downloadNative } = require('../electron/nativecore');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-native-ci-'));
let last = -10;
async function install() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await downloadNative(directory, value => {
        if (value.phase || value.pct >= last + 10) { console.log(value.phase || `Camoufox download ${value.pct}%`); last = value.pct; }
      });
    } catch (error) {
      if (attempt === 3 || !/HTTP 50\d|ECONNRESET|ETIMEDOUT|ENOTFOUND|超时|timed? ?out/i.test(error.message)) throw error;
      console.log(`Native download temporarily unavailable; retry ${attempt}/2`);
      await new Promise(resolve => setTimeout(resolve, attempt * 5000)); last = -10;
    }
  }
}
install().then(executable => {
  if (!process.env.GITHUB_ENV) throw new Error('This installer is intended for CI');
  fs.appendFileSync(process.env.GITHUB_ENV, `CIKE_CAMOUFOX_EXECUTABLE=${executable}\n`);
  console.log('Pinned native core installed and verified');
}).catch(error => { console.error(error); process.exitCode = 1; });
