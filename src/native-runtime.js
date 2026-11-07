'use strict';
const fs = require('fs');
const path = require('path');
const { privateDirectory, writePrivate } = require('./privatefiles');
const { nativeConfig, nativeEnvironment, nativeExecutable } = require('./nativecore');

function windowExtension(directory, bridge) {
  const extension = path.join(directory, 'cike-window-extension');
  privateDirectory(extension);
  writePrivate(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 2, name: 'CIKE Window Manager', version: '1.0',
    browser_specific_settings: { gecko: { id: 'cike-windows@local.invalid' } },
    permissions: ['http://' + new URL(bridge.url).hostname + '/*'], background: { scripts: ['config.js', 'background.js'] } }));
  writePrivate(path.join(extension, 'config.js'), 'const cikeWindowBridge=' + JSON.stringify(bridge) + ';');
  writePrivate(path.join(extension, 'background.js'), fs.readFileSync(path.join(__dirname, 'native-window-extension.js')));
  return extension;
}
async function launchNative({ dataDir, directory, profile, proxy, headless, downloadsDirectory, bridge }) {
  const config = nativeConfig(profile);
  if (bridge) config.addons = [windowExtension(directory, bridge)];
  const preferences = {
    'browser.download.folderList': 2, 'browser.download.useDownloadDir': true,
    'browser.download.dir': path.resolve(downloadsDirectory), 'browser.download.alwaysOpenPanel': true,
    'browser.startup.page': 0, 'browser.sessionstore.resume_from_crash': false,
    'network.proxy.socks_remote_dns': true, 'network.proxy.no_proxies_on': '', 'network.proxy.allow_hijacking_localhost': true,
  };
  if (proxy || profile.webrtc !== 'default') Object.assign(preferences, {
    'media.peerconnection.ice.proxy_only': true, 'media.peerconnection.ice.no_host': true,
    'media.peerconnection.ice.default_address_only': true, 'network.http.http3.enable': false,
  });
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
