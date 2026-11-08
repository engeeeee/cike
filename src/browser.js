'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { buildContextOptions, webrtcArgs, validateProfile } = require('./fingerprint');
const { resolveProxy, inlineRecord } = require('./proxyconfig');
const { ProxyStore } = require('./proxystore');
const { checkProxy } = require('./proxycheck');
const { privateDirectory } = require('./privatefiles');
const { prepareDownloads, configureDownloads } = require('./downloads');
const { WindowStateManager } = require('./windowstate');
const { launchWithGraphics } = require('./native-graphics');
const { within, stopContext, forceStopContext, ownedBrowser } = require('./browser-lifecycle');

function findFreePort(min, max) {
  return new Promise((resolve, reject) => {
    let port = min;
    const next = () => {
      if (port > max) return reject(new Error('no free debug port'));
      const s = net.createServer();
      s.once('error', () => { port++; next(); });
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
    };
    next();
  });
}
class BrowserManager {
  constructor(store, proxyStore = null, settings = null, options = {}) {
    this.store = store;
    this.proxyStore = proxyStore;
    this.settings = settings;
    this.downloadsDirectory = options.downloadsDirectory;
    this.checkProxy = options.checkProxy || checkProxy;
    this.sessions = new Map();
    this.opening = new Map();
    this.closing = new Map();
    this.cancelled = new Set();
    this.contexts = new Map();
    this.crashes = new Map();
    this.startPage = options.startPage !== false;
    this.profileIcons = options.profileIcons !== false;
    this.windowStates = new WindowStateManager(settings);
    this.windowTokens = new Map();
  }
  isOpen(id) { return this.sessions.has(id) || this.opening.has(id) || this.contexts.has(id); }
  windowWarning(id) {
    const session = this.sessions.get(id);
    if (!session?.windowControl) return null;
    if (session.windowControl.unavailable) return '窗口同步组件不可用，可手动调整窗口；浏览器继续运行';
    return this.windowTokens.get(session.windowControl.token)?.ready ? null : '窗口同步暂未连接，正在重试；可手动调整窗口';
  }
  listOpen() {
    return [...this.sessions].map(([id, s]) => ({ profile_id: id,
      ...(s.debugPort ? { debug_url: `http://127.0.0.1:${s.debugPort}` } : {}),
      headless: s.headless, opened_at: new Date(s.openedAt).toISOString(), network: s.network,
      ...(s.graphicsMode ? { graphicsMode: s.graphicsMode } : {}),
      ...(this.windowWarning(id) ? { warning: this.windowWarning(id) } : {}) }));
  }
  async open(id, options = {}) {
    if (this.kernelMaintenance || this.shuttingDown) throw Object.assign(new Error('正在管理浏览器内核或退出应用，请完成后再打开环境'), { status: 409 });
    if (this.closing.has(id)) await this.closing.get(id);
    if (this.kernelMaintenance || this.shuttingDown) throw Object.assign(new Error('正在管理浏览器内核或退出应用，请完成后再打开环境'), { status: 409 });
    if (this.opening.has(id)) return this.opening.get(id);
    if (!this.sessions.has(id) && this.contexts.has(id)) throw Object.assign(new Error('旧浏览器进程正在退出，请先关闭环境'), { status: 409 });
    this.cancelled.delete(id);
    const pending = this._open(id, options);
    this.opening.set(id, pending);
    try { return await pending; } finally { this.opening.delete(id); if (!this.closing.has(id)) this.cancelled.delete(id); }
  }
  async _open(id, { headless = false } = {}) {
    if (typeof headless !== 'boolean') throw Object.assign(new Error('headless 必须为布尔值'), { status: 400 });
    if (this.sessions.has(id)) return { profile_id: id, open: true, reused: true, ...this.listOpen().find(s => s.profile_id === id) };
    const profile = this.store.get(id);
    if (!profile) throw Object.assign(new Error('环境不存在'), { status: 404 });
    validateProfile(profile);
    const checkCancelled = () => { if (this.cancelled.has(id)) throw Object.assign(new Error('环境启动已取消'), { status: 409 }); };
    let proxyRecord = resolveProxy(profile, this.proxyStore);
    const useSystemProxy = this.settings?.get().socksViaSystemProxy === true;
    if (!proxyRecord && useSystemProxy) {
      const route = await this.settings.route();
      proxyRecord = inlineRecord({ server: `${route.scheme}://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}` });
    }
    const effective = { ...profile };
    let network = { route: proxyRecord ? 'proxy' : 'system', exitIp: null };
    if (proxyRecord) {
      const result = await this.checkProxy(proxyRecord, this.settings);
      checkCancelled();
      // The check awaited external I/O: refuse stale/deleted/rebound settings.
      const current = this.store.get(id);
      if (!current || current.updatedAt !== profile.updatedAt ||
          ((profile.proxyId || profile.proxy) && JSON.stringify(resolveProxy(current, this.proxyStore)) !== JSON.stringify(proxyRecord))) {
        throw Object.assign(new Error('环境或代理在检测期间发生变化，请重试'), { status: 409 });
      }
      if (profile.proxyId) this.proxyStore.setCheckResult(profile.proxyId, result);
      if (result.status !== 'ok') throw Object.assign(new Error(result.error || '代理连接失败，已阻止启动'), { status: 502 });
      if (profile.timezone === 'auto') {
        if (!result.timezone) throw Object.assign(new Error('代理出口时区未知，请重新检测或手动选择时区；不会回退到本机时区'), { status: 409 });
        effective.timezone = result.timezone;
      }
      if (profile.locale === 'auto') {
        const { localeForCountry } = require('./localemap');
        if (!result.countryCode) throw Object.assign(new Error('代理出口地区未知，请重新检测或手动选择语言'), { status: 409 });
        effective.locale = localeForCountry(result.countryCode);
        if (!effective.locale) throw Object.assign(new Error('没有此代理地区的语言映射，请手动选择语言'), { status: 409 });
      }
      network = { route: 'proxy', exitIp: result.exitIp, checkedAt: new Date().toISOString(), timezone: effective.timezone, locale: effective.locale };
    }
    // With no configured proxy, auto means native system locale/timezone;
    // no geolocation request, and no invented America/New_York fallback.
    let proxy = proxyRecord ? ProxyStore.toPlaywright(proxyRecord) : null;
    let forwarder, context, windowToken, windowBridge, windowControl, graphicsMode, graphicsFallback = false;
    const trackContext = launched => {
      this.contexts.set(id, launched);
      const process = ownedBrowser(launched)?.process;
      const forget = () => { if (this.contexts.get(id) === launched) this.contexts.delete(id); };
      if (process) process.once('exit', forget);
      launched.once('close', () => { if (!process || process.exitCode != null || process.signalCode != null) forget(); });
    };
    try {
      if (proxyRecord?.type === 'socks5' && (proxyRecord.username || proxyRecord.password || useSystemProxy)) {
        const { SocksForwarder } = require('./socksfwd');
        const systemProxy = useSystemProxy ? await this.settings.route(proxyRecord.host, proxyRecord.port) : null;
        forwarder = await SocksForwarder.start({ ...proxyRecord, systemProxy });
        proxy = { server: `http://127.0.0.1:${forwarder.port}`, bypass: '<-loopback>' };
      } else if (proxy) proxy.bypass = '<-loopback>';
      const kernel = profile.fingerprintMode === 'kernel';
      if (kernel && process.env.LFB_EXPOSE_DEBUGGER === '1') throw new Error('Camoufox 使用 Firefox 协议，不提供 Chromium CDP 调试端口');
      const { options } = buildContextOptions({ ...effective, proxy });
      const debugPort = !kernel && process.env.LFB_EXPOSE_DEBUGGER === '1' ? await findFreePort(4550, 4599) : null;
      const launchOptions = { ...options, headless, chromiumSandbox: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--no-first-run', '--no-default-browser-check', '--site-per-process', '--disable-background-mode',
          '--disable-blink-features=AutomationControlled',
          ...(effective.locale !== 'auto' ? [`--lang=${effective.locale}`, `--accept-lang=${effective.locale}`] : []),
          ...(debugPort ? [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] : []),
          ...webrtcArgs({ ...effective, proxy: proxy || useSystemProxy || profile.webrtc === 'auto' }),
        ],
      };
      if (!kernel && !headless && process.platform === 'win32') {
        await this.windowStates.capture();
        const state = this.windowStates.desired();
        launchOptions.viewport = null;
        delete launchOptions.deviceScaleFactor;
        launchOptions.args.push(state === 'fullscreen' ? '--start-fullscreen' : state === 'maximized'
          ? '--start-maximized' : `--window-size=${profile.viewport.width},${profile.viewport.height}`);
      }
      // Deliberately no arbitrary LFB_EXTRA_ARGS: they could disable sandbox,
      // alter proxy routing or invalidate the native consistency contract.
      if (process.env.LFB_CHROMIUM_EXECUTABLE) launchOptions.executablePath = process.env.LFB_CHROMIUM_EXECUTABLE;
      checkCancelled();
      if (!kernel && !headless && this.profileIcons) {
        launchOptions.executablePath = await require('./profileapp').ensureProfileApp(this.store.dataDir, profile, launchOptions.executablePath || chromium.executablePath());
        checkCancelled();
      }
      const directory = kernel ? path.join(this.store.profileDir(id), 'firefox') : this.store.profileDir(id);
      privateDirectory(directory);
      if (kernel) {
        const downloadsDirectory = this.downloadsDirectory || path.join(os.homedir(), 'Downloads');
        await fs.promises.mkdir(downloadsDirectory, { recursive: true });
        let bridge;
        if (!headless) {
          windowToken = crypto.randomBytes(24).toString('hex');
          this.windowTokens.set(windowToken, { profileId: id, ready: false });
          windowControl = { token: windowToken, unavailable: false };
          try {
            if (!this.createWindowBridge) throw new Error('window service unavailable');
            windowBridge = await this.createWindowBridge(windowToken);
            bridge = { url: windowBridge.url, token: windowToken };
          } catch (error) {
            windowControl.unavailable = true;
            this.windowTokens.delete(windowToken);
            console.error('[CIKE] window control:', error.code || error.message);
          }
        }
        const graphics = this.settings?.get();
        ({ context, graphicsMode, graphicsFallback } = await launchWithGraphics(mode => require('./native-runtime').launchNative({
          dataDir: this.store.dataDir, directory, profile: effective, proxy, headless, downloadsDirectory, bridge, graphicsMode: mode,
          onContext: trackContext,
        }), { mode: graphics?.camoufoxGraphicsMode || 'auto', remembered: graphics?.camoufoxAutoSoftware === true, beforeRetry: () => {
          checkCancelled();
          const entry = this.windowTokens.get(windowToken); if (entry) entry.ready = false;
        } }));
        let closed = false;
        context.once('close', () => { closed = true; });
        if (bridge) {
          const deadline = Date.now() + 3000;
          while (!this.windowTokens.get(windowToken)?.ready) {
            checkCancelled();
            if (closed) throw new Error('浏览器已关闭');
            // Window sizing is auxiliary. Keep a healthy proxied browser open
            // while the extension reconnects instead of treating it as a crash.
            if (Date.now() > deadline) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        if (closed) throw new Error('浏览器已关闭');
      } else {
        await prepareDownloads(directory, this.downloadsDirectory);
        context = await chromium.launchPersistentContext(directory, launchOptions);
        trackContext(context);
      }
      if (profile.fingerprintMode === 'hardware') await require('./hardware-runtime').installHardwareContext(context, profile);
      if (!kernel && !headless && process.platform === 'win32') await this.windowStates.attach(context);
      if (!kernel) await configureDownloads(context);
      checkCancelled();
      const session = { context, debugPort, headless, openedAt: Date.now(), forwarder, network, windowControl, graphicsMode };
      this.sessions.set(id, session);
      this.crashes.delete(id);
      context.on('close', () => { if (windowToken) this.windowTokens.delete(windowToken); if (this.sessions.get(id) === session) this.sessions.delete(id); forwarder?.stop().catch(() => {}); windowBridge?.close().catch(() => {}); });
      const watchPage = page => { page.on('crash', () => this.crashes.set(id, { time: new Date().toISOString() })); page.on('close', () => {
        // macOS leaves Chromium alive after its final window closes. Closing
        // the persistent context terminates only this environment's process.
        // Firefox may dispose a Juggler target during native-tab/process
        // replacement while its real window is still alive. Its page list is
        // not a window-lifetime signal; let Firefox exit on its last window.
        if (!kernel && !context.pages().some(p => !p.isClosed()) && this.sessions.get(id) === session) this.close(id).catch(() => {});
      }); };
      context.on('page', watchPage);
      for (const page of context.pages()) watchPage(page);
      if (!headless && this.startPage) await require('./startpage').openStartPage(context, profile, network, ip => {
        if (this.sessions.get(id) !== session) return;
        session.network = { ...session.network, exitIp: ip, checkedAt: new Date().toISOString() };
        this.store.recordNetwork(id, session.network);
      });
      checkCancelled();
      if (graphicsFallback) this.settings?.rememberCamoufoxSoftware();
      this.store.recordOpened(id, session.network);
      const warning = [graphicsFallback ? '检测到 GPU/D3D11 启动失败，已自动使用兼容绘制' : null, this.windowWarning(id)].filter(Boolean).join('；');
      return { profile_id: id, open: true, reused: false, headless, network,
        ...(graphicsMode ? { graphicsMode } : {}),
        ...(warning ? { warning } : {}),
        ...(debugPort ? { debug_url: `http://127.0.0.1:${debugPort}` } : {}) };
    } catch (error) {
      if (windowToken) this.windowTokens.delete(windowToken);
      await stopContext(context || this.contexts.get(id)).catch(() => {});
      await forwarder?.stop().catch(() => {});
      await windowBridge?.close().catch(() => {});
      // Playwright launch errors include argv, but proxy credentials are not
      // in argv. Do not retry by disabling sandbox or removing the proxy.
      throw error;
    }
  }
  async close(id) {
    if (this.closing.has(id)) return this.closing.get(id);
    this.cancelled.add(id);
    const pending = (async () => {
      await within(() => this.opening.get(id)?.catch(() => {}), 2000);
      const session = this.sessions.get(id);
      const context = session?.context || this.contexts.get(id);
      if (context) {
        if (session && !session.headless && process.platform === 'win32') await within(() => this.windowStates.capture().catch(() => {}), 500);
        await stopContext(context);
        await session?.forwarder?.stop();
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        if (this.contexts.get(id) === context) this.contexts.delete(id);
      }
      if (this.opening.has(id)) throw Object.assign(new Error('正在取消启动，请稍后重试'), { status: 409 });
      return { profile_id: id, open: false };
    })();
    this.closing.set(id, pending);
    try { return await pending; } finally { this.closing.delete(id); if (!this.opening.has(id)) this.cancelled.delete(id); }
  }
  async closeAll() {
    const ids = [...new Set([...this.opening.keys(), ...this.sessions.keys(), ...this.contexts.keys()])];
    await Promise.all(ids.map(id => this.close(id)));
    return { closed: ids.length };
  }
  getContext(id) { return this.sessions.get(id)?.context || null; }
  async forceStopAll() {
    await Promise.allSettled([...this.contexts.values()].map(context => forceStopContext(context)));
  }
  async manageKernel(operation) {
    if (this.shuttingDown) throw new Error('应用正在退出');
    if (this.kernelMaintenance) throw new Error('另一项内核操作正在进行，请稍后再试');
    if (this.sessions.size || this.opening.size || this.closing.size || this.contexts.size) throw new Error('请先关闭所有浏览器环境，再管理内核');
    this.kernelMaintenance = true;
    const task = Promise.resolve().then(operation); this.kernelTask = task;
    try { return await task; }
    finally { this.kernelMaintenance = false; if (this.kernelTask === task) this.kernelTask = null; }
  }
}
module.exports = { BrowserManager };
