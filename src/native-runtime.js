'use strict';
const fs = require('fs');
const path = require('path');
const { privateDirectory, writePrivate } = require('./privatefiles');
const { nativeConfig, nativeEnvironment, nativeExecutable } = require('./nativecore');
const { graphicsPreferences } = require('./native-graphics');

function windowExtension(directory, bridge) {
  const parent = path.join(directory, 'cike-window-extension');
  privateDirectory(parent);
  // A fresh resource URL prevents Firefox reusing the previous launch's token
  // or scripts from its extension startup cache. Preserve the browser profile.
  for (const name of fs.readdirSync(parent)) {
    if (!/^[a-f0-9]{48}$/.test(name)) continue;
    const old = path.join(parent, name);
    try {
      if (fs.lstatSync(old).isSymbolicLink() || !fs.lstatSync(old).isDirectory()) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(old, 'manifest.json'), 'utf8'));
      if (manifest.browser_specific_settings?.gecko?.id === 'cike-windows@local.invalid') fs.rmSync(old, { recursive: true, force: true, maxRetries: 2 });
    } catch { /* A locked old component must not prevent this launch. */ }
  }
  const extension = path.join(parent, bridge.token);
  privateDirectory(extension);
  writePrivate(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'CIKE Window Manager', version: '1.1',
    browser_specific_settings: { gecko: { id: 'cike-windows@local.invalid' } },
    permissions: ['http://' + new URL(bridge.url).hostname + '/*'], background: { scripts: ['config.js', 'background.js'] } }));
  writePrivate(path.join(extension, 'config.js'), 'const cikeWindowBridge=' + JSON.stringify(bridge) + ';');
  writePrivate(path.join(extension, 'background.js'), fs.readFileSync(path.join(__dirname, 'native-window-extension.js')));
  return extension;
}
function prepareStartupPreferences(directory, preferences) {
  const file = path.join(directory, 'user.js');
  let contents = '';
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Firefox user.js 不是普通文件');
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Set user-branch values before mirror-once graphics prefs are read. The
  // early CAMOU_PREFS defaults alone cannot override an existing profile.
  contents = contents.replace(/\n?\/\/ CIKE window bridge BEGIN\r?\n[\s\S]*?\/\/ CIKE window bridge END\r?\n?/g, '');
  contents = contents.replace(/\n?\/\/ CIKE native startup BEGIN\r?\n[\s\S]*?\/\/ CIKE native startup END\r?\n?/g, '');
  const lines = Object.entries(preferences).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  writePrivate(file, contents + '\n// CIKE native startup BEGIN\n' + lines.join('\n') + '\n// CIKE native startup END\n');
}
async function launchNative({ dataDir, directory, profile, proxy, headless, downloadsDirectory, bridge, graphicsMode = 'hardware' }) {
  const config = nativeConfig(profile);
  if (bridge) config.addons = [windowExtension(directory, bridge)];
  const preferences = {
    ...graphicsPreferences(graphicsMode),
    'browser.download.folderList': 2, 'browser.download.useDownloadDir': true,
    'browser.download.dir': path.resolve(downloadsDirectory), 'browser.download.alwaysOpenPanel': true,
    'browser.startup.page': 0, 'browser.sessionstore.resume_from_crash': false,
    // Juggler's bypass falls back to Firefox's inherited/system proxy. Exempt
    // the same private control IP at both layers so it stays on this machine.
    'network.proxy.socks_remote_dns': true, 'network.proxy.no_proxies_on': bridge ? new URL(bridge.url).hostname : '', 'network.proxy.allow_hijacking_localhost': true,
  };
  if (proxy || profile.webrtc !== 'default') Object.assign(preferences, {
    'media.peerconnection.ice.proxy_only': true, 'media.peerconnection.ice.no_host': true,
    'media.peerconnection.ice.default_address_only': true, 'network.http.http3.enable': false,
  });
  prepareStartupPreferences(directory, { ...graphicsPreferences(graphicsMode), 'network.proxy.no_proxies_on': preferences['network.proxy.no_proxies_on'] });
  const context = await require('playwright-native').firefox.launchPersistentContext(directory, {
    executablePath: nativeExecutable(dataDir), headless, viewport: null, acceptDownloads: true,
    ...(proxy ? { proxy: { ...proxy, bypass: bridge ? new URL(bridge.url).hostname : '' } } : {}),
    colorScheme: profile.colorScheme, firefoxUserPrefs: preferences, env: nativeEnvironment(config, preferences),
  });
  try {
    // Let Firefox's own download manager keep names/collision handling instead
    // of Playwright's temporary GUID files. No script runs in site pages.
    const server = context._connection?.toImpl?.(context), session = server?._browser?.session;
    if (!session?.send || require('playwright-native/package.json').version !== '1.62.0') throw new Error('指纹内核下载适配器不兼容');
    await session.send('Browser.setDownloadOptions', { browserContextId: server._browserContextId, downloadOptions: null });
    return context;
  } catch (error) { await context.close(); throw error; }
}
module.exports = { launchNative };
