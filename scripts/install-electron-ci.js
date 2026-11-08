'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { downloadFile } = require('../electron/chromium');
async function install() {
  const version = require('electron/package.json').version;
  const checksums = require('electron/checksums.json');
  const filename = `electron-v${version}-win32-x64.zip`;
  if (version !== '44.10.0' || checksums[filename] !== '64c2d874fea1bd4c8d2e1f2df3a547497044159a6b853dee7fcdff357ff0e3cd') throw new Error('Update the pinned Electron CI asset metadata');
  const { downloadArtifact } = await import('@electron/get');
  await downloadArtifact({ version, artifactName: 'electron', platform: 'win32', arch: 'x64', checksums,
    downloader: { download: async (url, file) => {
      try { await downloadFile(url, file); }
      catch (error) {
        if (!/HTTP 50\d|ECONNRESET|ETIMEDOUT|超时/i.test(error.message)) throw error;
        fs.rmSync(file, { force: true });
        await downloadFile('https://api.github.com/repos/electron/electron/releases/assets/682250993', file);
      }
    } },
  });
  execFileSync(process.execPath, [path.join(require.resolve('electron/package.json'), '..', 'install.js')], { stdio: 'inherit' });
}
install().catch(error => { console.error(error); process.exitCode = 1; });
