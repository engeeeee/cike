'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { downloadNative } = require('../electron/nativecore');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-native-ci-'));
let last = -10;
downloadNative(directory, value => {
  if (value.phase || value.pct >= last + 10) { console.log(value.phase || `Camoufox download ${value.pct}%`); last = value.pct; }
}).then(executable => {
  if (!process.env.GITHUB_ENV) throw new Error('This installer is intended for CI');
  fs.appendFileSync(process.env.GITHUB_ENV, `CIKE_CAMOUFOX_EXECUTABLE=${executable}\n`);
  console.log('Pinned native core installed and verified');
}).catch(error => { console.error(error); process.exitCode = 1; });
