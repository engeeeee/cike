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
    '/reference:System.Web.Extensions.dll', '/reference:System.Drawing.dll', '/out:' + binary, '/resource:' + manifest + ',CIKE.KernelHashes.json',
    path.join(__dirname, 'windows-core-report.cs'), path.join(__dirname, 'windows-core-access.cs')], { stdio: 'inherit' });
  execFileSync(binary, ['--self-test'], { stdio: 'inherit' });
  const fixture = path.join(root, 'dist', 'host-diagnostic-test.json');
  execFileSync(binary, ['--kernel', executable, '--probe', '--output', fixture], { stdio: 'inherit' });
  const report = JSON.parse(fs.readFileSync(fixture));
  if (!report.os.length || !report.cpu.length || report.kernel.files.some(file => file.status !== 'match')) throw new Error('Native host/integrity verification failed');
  if (!report.loaderAccess.lowToken || report.renderProbes?.length !== 2 || report.renderProbes.some(probe => probe.status !== 'painted')) throw new Error('Offline native rendering verification failed: ' + JSON.stringify(report));
  fs.rmSync(manifest);
  fs.writeFileSync(path.join(output, '使用说明.txt'), '\ufeff' + [
    'CIKE / Camoufox Windows 内核诊断', '',
    '1. 完整解压，双击 CIKE-Core-Diagnostic.exe。无需安装或管理员权限。',
    '2. 工具会自动检查执行权限，并用两个临时环境测试本地页面，最长约一分钟，无需手动打开 CIKE。',
    '3. 桌面会生成 CIKE-Camoufox-report-日期时间.json，将这份报告发回用于定位。', '',
    '收集：系统/CPU/显卡与驱动、内存、关键文件完整性、目录和 DLL 的读取/执行权限、安全策略拦截记录，以及临时进程树退出码。',
    '自动测试只打开 data: 本地页面，临时环境强制使用不可连接的本机代理并禁止直连回退，测试结束后清理。',
    '工具不打开现有浏览器环境，不读取 Cookie/密码/代理配置，不修改内核、权限、注册表或系统安全设置，不上传数据。',
    '保留浏览器原有沙箱保护；不会通过关闭沙箱、杀毒软件或全局安全防护来试启动。',
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
