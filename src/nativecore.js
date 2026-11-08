'use strict';
const fs = require('fs');
const path = require('path');
const { GPU_PRESETS, CPU_VALUES } = require('./hardware');

// Pin both the browser and its automation driver. No floating "latest" binary.
const RELEASE = 'v158.0.1-beta.41';
const BUILD = '158.0.1-beta.41';
const ASSETS = {
  'win32-x64': ['camoufox-158.0.1-beta.41-win.x86_64.zip', '2644bd14f1cc345c768f6a70b576bcc87eb3d0bf0df54856d6fe0bbc3027515f'],
  'linux-arm64': ['camoufox-158.0.1-beta.41-lin.arm64.zip', '60e25f6eb95e13d9ec655bc02913d51057e669cb31542e6ace9d2190ab5380af'],
  'linux-x64': ['camoufox-158.0.1-beta.41-lin.x86_64.zip', '3f2eb1d0451fa58e45e43e55f5e6181565069791ae60c0574f0ceb1f01341c33'],
};
function nativeAsset(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error('指纹内核目前支持 Windows x64 和 Linux x64/ARM64');
  return { name: asset[0], sha256: asset[1], url: `https://github.com/daijro/camoufox/releases/download/${RELEASE}/${asset[0]}`,
    ...(platform === 'win32' && arch === 'x64' ? { apiUrl: 'https://api.github.com/repos/daijro/camoufox/releases/assets/690066539' } : {}) };
}
function nativeMarker(dir) { return path.join(dir, 'browsers', 'camoufox-executable.txt'); }
function nativeExecutable(dir) {
  const executable = process.env.CIKE_CAMOUFOX_EXECUTABLE || (fs.existsSync(nativeMarker(dir)) ? fs.readFileSync(nativeMarker(dir), 'utf8').trim() : '');
  if (!executable || !fs.existsSync(executable)) throw new Error('请先在“设置 → Camoufox 指纹内核”下载内核');
  const version = fs.readFileSync(path.join(path.dirname(executable), 'application.ini'), 'utf8').match(/^Version=(.+)$/m)?.[1].trim();
  if (version !== BUILD) throw new Error(`指纹内核版本不匹配，需要 ${BUILD}`);
  return executable;
}
function validateKernel(profile) {
  if (!CPU_VALUES.includes(profile.hardwareConcurrency)) throw Object.assign(new Error('请选择有效的 CPU 线程数'), { status: 400 });
  if (!Object.hasOwn(GPU_PRESETS, profile.gpuPreset)) throw Object.assign(new Error('请选择有效的显卡标识'), { status: 400 });
  if (profile.deviceMemory != null || profile.canvasNoise || profile.audioNoise) throw Object.assign(new Error('内核模式使用 Firefox 原生内存接口、Canvas 和音频，不支持脚本噪声'), { status: 400 });
}
function nativeConfig(profile) {
  validateKernel(profile);
  const config = { 'navigator.hardwareConcurrency': profile.hardwareConcurrency };
  const locale = profile.locale === 'auto' ? Intl.DateTimeFormat().resolvedOptions().locale : profile.locale;
  config['locale:all'] = [...new Set([locale, locale.split('-')[0]])].join(', ');
  if (profile.timezone !== 'auto') config.timezone = profile.timezone;
  const gpu = GPU_PRESETS[profile.gpuPreset];
  if (gpu.vendor) { config['webGl:vendor'] = gpu.vendor; config['webGl:renderer'] = gpu.renderer; }
  return config;
}
function nativeEnvironment(config, preferences) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^CAMOU_(CONFIG|PREFS)_\d+$/.test(name)) delete env[name];
  for (const [prefix, value] of [['CAMOU_CONFIG_', config], ['CAMOU_PREFS_', preferences]]) {
    // ASCII JSON also survives Firefox autoconfig's Windows ANSI getenv().
    const json = JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    for (let i = 0; i < json.length; i += 2047) env[prefix + (i / 2047 + 1)] = json.slice(i, i + 2047);
  }
  return env;
}
module.exports = { RELEASE, BUILD, nativeAsset, nativeMarker, nativeExecutable, validateKernel, nativeConfig, nativeEnvironment };
