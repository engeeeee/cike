'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zipDirectory } = require('./archive');

async function main() {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'dist');
  const manifest = require('../package.json');
  fs.mkdirSync(out, { recursive: true });
  const { default: pngToIco } = await import('png-to-ico');
  const icon = path.join(out, 'cike-windows.ico');
  fs.writeFileSync(icon, await pngToIco(path.join(root, 'electron/assets/icon.png')));
  const { packager } = await import('electron-packager');
  const [directory] = await packager({
    dir: root, name: 'CIKE', executableName: 'CIKE', platform: 'win32', arch: 'x64',
    electronVersion: manifest.devDependencies.electron, appVersion: manifest.version,
    icon, out, overwrite: true, prune: true,
    ignore: [/^\/(test|docs|scripts|dist|data|\.browsers|\.github|\.git)(\/|$)/,
      /^\/build-windows\.cmd$/, /\.zip$/i, /\.log$/i],
    win32metadata: { CompanyName: 'CIKE Community', FileDescription: 'CIKE Windows',
      ProductName: 'CIKE', 'requested-execution-level': 'asInvoker' },
  });
  fs.copyFileSync(path.join(root, 'docs/WINDOWS.md'), path.join(directory, 'Windows使用说明.md'));
  fs.copyFileSync(path.join(root, 'docs/HARDWARE.md'), path.join(directory, 'HARDWARE.md'));
  fs.writeFileSync(path.join(directory, '使用说明.txt'), '\ufeff' + [
    'CIKE Windows x64 独立移植版',
    '',
    '1. 将整个压缩包解压到本地目录，双击 CIKE.exe。不要单独移动 exe。',
    '2. 打开“设置”，下载 Chromium 内核，然后创建并打开环境。',
    '3. 数据默认保存在 %LOCALAPPDATA%\\CIKE，浏览器下载保存在系统下载目录。',
    '4. 更新前退出应用，将新版解压到新目录；无需复制或删除数据目录。',
    '5. 浏览器默认最大化，并记住 F11 全屏选择；可在“设置 → 浏览器窗口”更改。',
    '6. 硬件模拟需在新建/编辑环境的“指纹选项”中启用，范围和限制见 HARDWARE.md。',
    '',
    '适用于 Windows 10 1803 及以上、Windows 11，Intel/AMD 64 位。',
    '本包未做代码签名。它是独立移植版，不是上游 macOS 官方发布。',
    '详细说明、已验证范围与实机验收清单见 Windows使用说明.md。',
    '',
  ].join('\r\n'));
  const filename = `CIKE-${manifest.version}-windows-x64.zip`;
  const archive = path.join(out, filename);
  await zipDirectory(directory, archive);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${hash.digest('hex')}  ${filename}\n`);
  console.log(`Windows package: ${archive}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
