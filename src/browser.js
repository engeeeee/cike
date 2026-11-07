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
    this.startPage = options.startPage !== false;
    this.profileIcons = options.profileIcons !== false;
    this.windowStates = new WindowStateManager(settings);
    this.windowTokens = new Map();
  }
  isOpen(id) { return this.sessions.has(id) || this.opening.has(id); }
  listOpen() {
    return [...this.sessions].map(([id, s]) => ({ profile_id: id,
      ...(s.debugPort ? { debug_url: `http://127.0.0.1:${s.debugPort}` } : {}),
      headless: s.headless, opened_at: new Date(s.openedAt).toISOString(), network: s.network }));
  }
  async open(id, options = {}) {
    if (this.closing.has(id)) await this.closing.get(id);
    if (this.opening.has(id)) return this.opening.get(id);
    this.cancelled.delete(id);
    const pending = this._open(id, options);
    this.opening.set(id, pending);
    try { return await pending; } finally { this.opening.delete(id); }
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
    let forwarder, context, windowToken;
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
          if (!this.localAPIUrl) throw new Error('指纹内核窗口管理需要通过 CIKE 本地服务启动');
          windowToken = crypto.randomBytes(24).toString('hex');
          this.windowTokens.set(windowToken, { profileId: id, ready: false });
          const endpoint = new URL('api/browserWindows', this.localAPIUrl);
          // A private .localhost capability host lets the control extension
          // reach CIKE without bypassing the proxy for ordinary localhost URLs.
          endpoint.hostname = windowToken + '.localhost';
          bridge = { url: endpoint.href, token: windowToken };
        }
        context = await require('./native-runtime').launchNative({ dataDir: this.store.dataDir, directory, profile: effective, proxy, headless, downloadsDirectory, bridge });
        if (bridge) {
          const deadline = Date.now() + 20000;
          while (!this.windowTokens.get(windowToken)?.ready) {
            checkCancelled();
            if (Date.now() > deadline) throw new Error('指纹内核窗口组件未能连接，请重试');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      } else {
        await prepareDownloads(directory, this.downloadsDirectory);
        context = await chromium.launchPersistentContext(directory, launchOptions);
      }
      if (profile.fingerprintMode === 'hardware') await require('./hardware-runtime').installHardwareContext(context, profile);
      if (!kernel && !headless && process.platform === 'win32') await this.windowStates.attach(context);
      if (!kernel) await configureDownloads(context);
      checkCancelled();
      const session = { context, debugPort, headless, openedAt: Date.now(), forwarder, network };
      this.sessions.set(id, session);
      context.on('close', () => { if (windowToken) this.windowTokens.delete(windowToken); if (this.sessions.get(id) === session) this.sessions.delete(id); forwarder?.stop().catch(() => {}); });
      const watchPage = page => page.on('close', () => {
        // macOS leaves Chromium alive after its final window closes. Closing
        // the persistent context terminates only this environment's process.
        if (!context.pages().some(p => !p.isClosed()) && this.sessions.get(id) === session) this.close(id).catch(() => {});
      });
      context.on('page', watchPage);
      for (const page of context.pages()) watchPage(page);
      if (!headless && this.startPage) await require('./startpage').openStartPage(context, profile, network, ip => {
        if (this.sessions.get(id) !== session) return;
        session.network = { ...session.network, exitIp: ip, checkedAt: new Date().toISOString() };
        this.store.recordNetwork(id, session.network);
      });
      checkCancelled();
      this.store.recordOpened(id, session.network);
      return { profile_id: id, open: true, reused: false, headless, network,
        ...(debugPort ? { debug_url: `http://127.0.0.1:${debugPort}` } : {}) };
    } catch (error) {
      if (windowToken) this.windowTokens.delete(windowToken);
      await context?.close().catch(() => {});
      await forwarder?.stop().catch(() => {});
      // Playwright launch errors include argv, but proxy credentials are not
      // in argv. Do not retry by disabling sandbox or removing the proxy.
      throw error;
    }
  }
  async close(id) {
    if (this.closing.has(id)) return this.closing.get(id);
    this.cancelled.add(id);
    const pending = (async () => {
      await this.opening.get(id)?.catch(() => {});
      const session = this.sessions.get(id);
      if (session) {
        if (!session.headless && process.platform === 'win32') await this.windowStates.capture().catch(error => console.error('[CIKE] remember window:', error.message));
        await session.context.close();
        await session.forwarder?.stop();
        if (this.sessions.get(id) === session) this.sessions.delete(id);
      }
      return { profile_id: id, open: false };
    })();
    this.closing.set(id, pending);
    try { return await pending; } finally { this.closing.delete(id); this.cancelled.delete(id); }
  }
  async closeAll() {
    const ids = [...new Set([...this.opening.keys(), ...this.sessions.keys()])];
    await Promise.all(ids.map(id => this.close(id)));
    return { closed: ids.length };
  }
  getContext(id) { return this.sessions.get(id)?.context || null; }
}
module.exports = { BrowserManager };
