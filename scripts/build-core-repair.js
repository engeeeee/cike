'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { BUILD, nativeExecutable } = require('../src/nativecore');
const { inventory } = require('../src/native-storage');
const { zipDirectory } = require('./archive');
async function digest(file) {
  const sha = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}
async function main() {
  if (process.platform !== 'win32') throw new Error('Build and test this utility on Windows');
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'dist', 'core-repair');
  fs.mkdirSync(output, { recursive: true });
  const executable = nativeExecutable(path.join(root, 'data')), kernel = path.dirname(executable), files = [];
  for (const file of await inventory(kernel)) {
    if (file.directory || !/\.(exe|dll|ja|cfg|manifest|ini)$/i.test(file.name)) continue;
    files.push({ name: file.name.replaceAll(path.sep, '/'), sha256: await digest(path.join(kernel, file.name)) });
  }
  if (!files.some(file => file.name === 'xul.dll') || !files.some(file => file.name === 'camoufox.exe')) throw new Error('Missing verified Windows core');
  const manifest = path.join(output, 'KernelHashes.json'), binary = path.join(output, 'CIKE-Core-Repair.exe');
  fs.writeFileSync(manifest, JSON.stringify({ build: BUILD, files }));
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/main:CikeCoreRepair', '/platform:anycpu', '/optimize+', '/codepage:65001',
    '/reference:System.Management.dll', '/reference:System.Web.Extensions.dll', '/reference:System.Drawing.dll',
    '/out:' + binary, '/resource:' + manifest + ',CIKE.KernelHashes.json',
    ...['windows-core-report.cs', 'windows-core-access.cs', 'windows-core-repair.cs'].map(file => path.join(__dirname, file))], { stdio: 'inherit' });
  // Reproduce native C0000022 with the original sandbox, then require the
  // repaired copy to render, open windows and preserve the original profile.
  execFileSync(binary, ['--self-test', executable], { stdio: 'inherit', timeout: 420000 });
  fs.rmSync(manifest);
  fs.writeFileSync(path.join(output, '使用说明.txt'), '\ufeff' + [
    'CIKE / Camoufox 内核目录修复 v1', '',
    '适用：系统 DLL 可读取，但低完整性令牌访问现有内核被拒绝，内容子进程以 0xC0000022 退出。', '',
    '1. 完全退出 CIKE，保留原内核文件夹，不要删除浏览器环境。',
    '2. 完整解压后，双击 CIKE-Core-Repair.exe。无需安装或预先重新下载内核。',
    '3. 工具将原内核复制到系统盘 CIKE 默认内核目录，逐文件校验并测试低权限读取、离线页面和实际窗口。',
    '4. 只有全部验证通过才切换选择和下载位置。原副本、原设置备份以及现有浏览器环境均保留。',
    '5. 工具提示切换成功后，重新打开 CIKE，使用原先的浏览器环境。',
    '预计 1–4 分钟，取决于磁盘速度；测试窗口会自动关闭，无需手动操作。', '',
    '系统盘需要容纳一份内核副本。验证不通过时不会切换，可将桌面生成的 CIKE-Camoufox-repair-日期时间.json 发回继续定位。',
    '现有内核或目录之外的安全策略仍可能阻止副本；本工具不会关闭沙箱或杀毒软件，也不会改系统目录或原内核的权限。',
    '新副本使用私有目录权限与中等完整性，只允许沙箱读取，不赋予沙箱写权限。',
    '自动测试仅打开本地 data: 页面，强制不可用本机代理并禁止直连回退。不会打开已有环境、读取 Cookie/密码/代理配置或上传数据。',
    '已在 Windows 用真实内核复现访问拒绝并验证修复、回滚和数据保留；你的电脑是否适用以本机验证结果为准。', '',
  ].join('\r\n'));
  const archive = path.join(root, 'dist', 'CIKE-Camoufox-Repair-windows.zip');
  await zipDirectory(output, archive);
  fs.writeFileSync(path.join(root, 'dist', 'REPAIR-SHA256SUMS.txt'), await digest(archive) + '  ' + path.basename(archive) + '\n');
  console.log('Standalone core repair built after real Windows access-denied regression');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
