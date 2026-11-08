'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { BUILD, nativeExecutable } = require('../src/nativecore');
const { inventory } = require('../src/native-storage');
const { zipDirectory } = require('./archive');
async function digest(file) {
  const sha = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) sha.update(chunk); return sha.digest('hex');
}
async function main() {
  if (process.platform !== 'win32') throw new Error('Build this .NET Framework utility on Windows');
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'dist', 'core-report');
  fs.mkdirSync(output, { recursive: true });
  const executable = nativeExecutable(path.join(root, 'data'));
  const kernel = path.dirname(executable), files = [];
  for (const file of await inventory(kernel)) {
    if (file.directory || !/\.(exe|dll|ja|cfg|manifest|ini)$/i.test(file.name)) continue;
    files.push({ name: file.name.replaceAll(path.sep, '/'), sha256: await digest(path.join(kernel, file.name)) });
  }
  if (!files.some(file => file.name === 'xul.dll') || !files.some(file => file.name === 'camoufox.exe')) throw new Error('Missing verified Windows core');
  const manifest = path.join(output, 'KernelHashes.json');
  fs.writeFileSync(manifest, JSON.stringify({ build: BUILD, files }));
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const binary = path.join(output, 'CIKE-Core-Diagnostic.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/codepage:65001', '/reference:System.Management.dll',
    '/reference:System.Web.Extensions.dll', '/out:' + binary, '/resource:' + manifest + ',CIKE.KernelHashes.json',
    path.join(__dirname, 'windows-core-report.cs')], { stdio: 'inherit' });
  execFileSync(binary, ['--self-test'], { stdio: 'inherit' });
  const fixture = path.join(root, 'dist', 'host-diagnostic-test.json');
  execFileSync(binary, ['--kernel', executable, '--output', fixture], { stdio: 'inherit' });
  const report = JSON.parse(fs.readFileSync(fixture));
  if (!report.os.length || !report.cpu.length || report.kernel.files.some(file => file.status !== 'match')) throw new Error('Native host/integrity verification failed');
  fs.rmSync(manifest);
  fs.writeFileSync(path.join(output, '使用说明.txt'), '\ufeff' + [
    'CIKE / Camoufox Windows 内核诊断', '',
    '1. 完整解压，双击 CIKE-Core-Diagnostic.exe。无需安装或管理员权限。',
    '2. 窗口提示开始记录后，回到 CIKE 打开会崩溃的环境一次。保持诊断窗口，等待 45 秒。',
    '3. 桌面会生成 CIKE-Camoufox-report-日期时间.json，将这份报告发回用于定位。', '',
    '收集：系统/CPU/显卡与驱动、内存、关键文件完整性、近期原生故障，以及本次 Camoufox 进程树的退出码。',
    '工具不会启动浏览器、修改注册表或环境、读取 Cookie/密码/代理配置，也不会上传数据。',
    '这是诊断工具，不代表 Camoufox 的崩溃已经修好。原内核、环境和登录数据保持原样。',
    '适用于 Windows 10/11。校验值见 DIAGNOSTIC-SHA256SUMS.txt。', '',
  ].join('\r\n'));
  const archive = path.join(root, 'dist', 'CIKE-Camoufox-Diagnostic-windows.zip');
  await zipDirectory(output, archive);
  const sha = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(archive)) sha.update(chunk);
  fs.writeFileSync(path.join(root, 'dist', 'DIAGNOSTIC-SHA256SUMS.txt'), sha.digest('hex') + '  ' + path.basename(archive) + '\n');
  console.log('Standalone diagnostic built and verified with ' + files.length + ' official core reference files');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
