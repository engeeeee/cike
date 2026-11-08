'use strict';
/**
 * CIKE — Electron shell.
 * Main process starts the local backend (Koa API + profile/browser manager)
 * and hosts the management UI, which talks to the same Local API over HTTP.
 */
const { app, BrowserWindow, ipcMain, shell, session, safeStorage, dialog, clipboard } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const { startBackend, DATA_DIR } = require('../src/server');
const { chromiumStatus, downloadChromium, executableMarker } = require('./chromium');
const { checkUpdate, installUpdate } = require('./updater');
const { nativeStatus, downloadNative, verifyNativeExecutable } = require('./nativecore');
const { NativeStorage } = require('../src/native-storage');
const nativeStorage = new NativeStorage(DATA_DIR, { verify: verifyNativeExecutable });
const { within } = require('../src/browser-lifecycle');

let backend = null;
let mainWindow = null;
let quitting = false, quitReady = false, reopenRequested = false;
const uiFile = path.join(__dirname, 'renderer', 'index.html');
const uiURL = pathToFileURL(uiFile).href;
if (process.env.LFB_DATA) app.setPath('userData', path.join(DATA_DIR, 'desktop'));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (quitting) reopenRequested = true;
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  else if (backend && !quitting) createWindow();
});
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Untrusted IPC sender');
}
ipcMain.on('connection-info', event => {
  try { trusted(event); event.returnValue = { apiBase: backend.url, token: backend.token }; }
  catch { event.returnValue = {}; }
});

// If Chromium was downloaded before, point the backend at it.
function applyChromiumEnv() {
  try {
    const exe = fs.readFileSync(executableMarker(DATA_DIR), 'utf8').trim();
    if (exe) process.env.LFB_CHROMIUM_EXECUTABLE = exe;
  } catch { /* not downloaded yet */ }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'CIKE',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', event => {
    // Keep a visible window while the browser processes stop. Previously the
    // final window vanished before before-quit awaited a hung Juggler session.
    if (process.platform !== 'darwin' && backend && !quitReady) { event.preventDefault(); app.quit(); }
  });
  await mainWindow.loadFile(uiFile);
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('io.cike.windows');
  applyChromiumEnv();
  try {
    const requireSafeStorage = () => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全读取或迁移代理凭据');
    };
    backend = await startBackend(undefined, {
      secretStorage: {
        encrypt: value => { requireSafeStorage(); return safeStorage.encryptString(value).toString('base64'); },
        decrypt: value => { requireSafeStorage(); return safeStorage.decryptString(Buffer.from(value, 'base64')); },
      },
      resolveSystemProxy: url => session.defaultSession.resolveProxy(url), downloadsDirectory: app.getPath('downloads'),
    });
  } catch (err) {
    console.error('[CIKE] backend failed to start:', err.message);
    dialog.showErrorBox('CIKE 无法启动', err.message);
    app.exit(1);
    return;
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (quitReady || !backend) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle('CIKE — 正在关闭浏览器…');
  backend.browsers.shuttingDown = true;
  // Let an in-flight file migration finish atomically. The browser shutdown
  // itself has a deadline even if a crashed target never answers Juggler.
  Promise.resolve(backend.browsers.kernelTask).catch(() => {}).then(async () => {
    try { await within(() => backend.browsers.closeAll(), 8000); } catch {}
    await backend.browsers.forceStopAll();
  }).finally(() => {
    backend.server.closeAllConnections(); backend.server.close();
    quitReady = true;
    if (reopenRequested) app.relaunch();
    app.exit(0);
  });
});

// --- renderer IPC ---

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => { trusted(event); return callback(event, ...args); });
}
handle('chromium-status', async () => {
  return chromiumStatus(DATA_DIR);
});
handle('native-status', () => nativeStatus(DATA_DIR));
handle('native-diagnostics-export', async () => {
  try {
    const directory = path.join(DATA_DIR, 'diagnostics');
    const reports = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^p_[a-f0-9]{12}\.json$/.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) : [];
    if (!reports.length) return { ok: false, error: '还没有崩溃诊断记录。环境下次启动失败或标签页崩溃时会自动记录。' };
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出 Camoufox 崩溃诊断',
      defaultPath: path.join(app.getPath('downloads'), 'CIKE-diagnostics.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    require('../src/privatefiles').writeJSON(result.filePath, { reports });
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
function progressSender(event, channel) {
  return value => { if (!event.sender.isDestroyed()) event.sender.send(channel, value); };
}
async function manageKernel(operation) {
  try { return await backend.browsers.manageKernel(operation); }
  catch (error) { return { ok: false, error: error.message }; }
}
handle('native-storage-status', async () => ({ ...await nativeStorage.status(),
  inUse: !!(backend.browsers.sessions.size || backend.browsers.opening.size || backend.browsers.closing.size),
  busy: !!backend.browsers.kernelMaintenance,
}));
handle('native-storage-change', event => manageKernel(async () => {
  const status = await nativeStorage.status();
  const chosen = await dialog.showOpenDialog(mainWindow, { title: '选择 Camoufox 内核保存位置', defaultPath: status.root,
    properties: ['openDirectory', 'createDirectory'] });
  if (chosen.canceled || !chosen.filePaths[0]) return { ok: true, canceled: true };
  const root = nativeStorage.validateRoot(chosen.filePaths[0]);
  const current = status.entries.find(entry => entry.current && entry.compatible);
  const confirmation = await dialog.showMessageBox(mainWindow, { type: 'question', title: '更改内核位置',
    message: current ? '复制并验证内核后切换到新位置？' : '将后续内核下载保存到此位置？',
    detail: `${current ? '当前位置：' + current.directory + '\n' : ''}保存位置：${root}\n\n` +
      (current ? '需要约 ' + (current.bytes / 1024 ** 3).toFixed(2) + ' GB 可用空间。校验和试启动成功后才会切换，旧副本保留，可稍后在列表中删除。' :
        (status.external ? '当前使用环境变量指定的外部内核，本操作仅更改后续下载位置，不移动外部文件。' : '尚无可迁移的内核。下次下载会使用所选位置。')) +
      '\n环境、Cookie 和登录数据保持不变。',
    buttons: ['取消', '确认'], defaultId: 0, cancelId: 0 });
  if (confirmation.response !== 1) return { ok: true, canceled: true };
  return { ok: true, ...await nativeStorage.changeRoot(root, progressSender(event, 'native-storage-progress')) };
}));
handle('native-storage-remove', (_event, id) => manageKernel(async () => {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('无效的内核记录');
  const plan = await nativeStorage.deletionPlan(id);
  const confirmation = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '删除 Camoufox 内核',
    message: plan.needsDownload ? '卸载当前内核？再次使用“内核模拟”需要重新下载。' : '删除这份内核文件？',
    detail: plan.entry.directory + '\n\n' + (plan.fallback ? '会先切换到已通过启动验证的另一份内核。\n' : '') +
      '仅删除这份内核文件，保留环境配置、Cookie、登录数据和其他文件。',
    buttons: ['取消', plan.needsDownload ? '卸载内核' : '删除'], defaultId: 0, cancelId: 0 });
  if (confirmation.response !== 1) return { ok: true, canceled: true };
  return { ok: true, ...await nativeStorage.remove(id) };
}));
handle('native-storage-open', async (_event, id) => {
  try {
    const status = await nativeStorage.status();
    const directory = id === 'root' ? status.root : id === 'current' ? path.dirname(status.current || '') : status.entries.find(entry => entry.id === id)?.directory;
    if (!directory || (id === 'current' && !status.current) || !fs.statSync(directory).isDirectory()) throw new Error('目录不存在');
    const error = await shell.openPath(directory); if (error) throw new Error(error);
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
handle('native-download', async event => {
  return manageKernel(async () => {
    const executable = await downloadNative(DATA_DIR, progressSender(event, 'native-download-progress'));
    return { ok: true, executable };
  });
});

handle('chromium-download', async (event) => {
  const send = progressSender(event, 'chromium-download-progress');
  return manageKernel(async () => {
    const exe = await downloadChromium(DATA_DIR, send);
    process.env.LFB_CHROMIUM_EXECUTABLE = exe;
    return { ok: true, executable: exe };
  });
});

handle('open-data-dir', async () => {
  shell.openPath(backend.dataDir);
  return { ok: true };
});

handle('proxy-clipboard', async () => {
  try { return { ok: true, proxy: require('../src/proxyparse').parseProxyLine(await clipboard.readText()) }; }
  catch { return { ok: false }; }
});
handle('update-check', () => checkUpdate());
handle('update-install', () => installUpdate());
