'use strict';
const { privateDirectory, readJSON, writeJSON } = require('./privatefiles');
const path = require('path');
const { parseSystemProxy } = require('./proxyroute');
const { GRAPHICS_MODES } = require('./native-graphics');
class Settings {
  constructor(dir, resolveSystemProxy) {
    this.file = path.join(dir, 'settings.json');
    this.resolveSystemProxy = resolveSystemProxy;
    privateDirectory(dir);
    const saved = readJSON(this.file, {});
    this.value = { socksViaSystemProxy: saved.socksViaSystemProxy === true,
      camoufoxGraphicsMode: GRAPHICS_MODES.includes(saved.camoufoxGraphicsMode) ? saved.camoufoxGraphicsMode : 'auto',
      camoufoxAutoSoftware: saved.camoufoxAutoSoftware === true,
      browserWindowMode: ['remember', 'maximized', 'fullscreen', 'normal'].includes(saved.browserWindowMode) ? saved.browserWindowMode : 'remember',
      browserWindowState: ['normal', 'maximized', 'fullscreen'].includes(saved.browserWindowState) ? saved.browserWindowState : 'maximized' };
  }
  get() { return { ...this.value }; }
  set(value) {
    const next = { ...this.value };
    if (Object.hasOwn(value, 'camoufoxGraphicsMode')) {
      if (!GRAPHICS_MODES.includes(value.camoufoxGraphicsMode)) throw new Error('请选择有效的 Camoufox 图形渲染模式');
      next.camoufoxGraphicsMode = value.camoufoxGraphicsMode;
      next.camoufoxAutoSoftware = false;
    }
    if (Object.hasOwn(value, 'socksViaSystemProxy')) {
      if (typeof value.socksViaSystemProxy !== 'boolean') throw new Error('请选择是否通过系统代理');
      next.socksViaSystemProxy = value.socksViaSystemProxy;
    }
    if (Object.hasOwn(value, 'browserWindowMode')) {
      if (!['remember', 'maximized', 'fullscreen', 'normal'].includes(value.browserWindowMode)) throw new Error('请选择有效的浏览器窗口模式');
      next.browserWindowMode = value.browserWindowMode;
    }
    writeJSON(this.file, next);
    this.value = next;
    return this.get();
  }
  rememberWindowState(state) {
    if (this.value.browserWindowMode !== 'remember' || !['normal', 'maximized', 'fullscreen'].includes(state) || state === this.value.browserWindowState) return;
    const next = { ...this.value, browserWindowState: state };
    writeJSON(this.file, next);
    this.value = next;
  }
  rememberCamoufoxSoftware() {
    if (this.value.camoufoxGraphicsMode !== 'auto' || this.value.camoufoxAutoSoftware) return;
    const next = { ...this.value, camoufoxAutoSoftware: true };
    writeJSON(this.file, next); this.value = next;
  }
  async route(host, port) {
    if (!this.value.socksViaSystemProxy) return null;
    if (!this.resolveSystemProxy) throw new Error('系统代理功能需要使用 CIKE 桌面客户端');
    const target = host ? `https://${host.includes(':') ? `[${host}]` : host}:${port}/` : 'https://example.com/';
    return parseSystemProxy(await this.resolveSystemProxy(target));
  }
}
module.exports = { Settings };
