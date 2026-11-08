'use strict';
const GRAPHICS_MODES = ['auto', 'hardware', 'software'];
function graphicsPreferences(mode, platform = process.platform) {
  const software = mode === 'software';
  const preferences = {
    'gfx.webrender.software': software,
    'gfx.webrender.compositor': !software,
    'layers.acceleration.disabled': software,
    'layers.gpu-process.enabled': !software && platform === 'win32',
    'layers.gpu-process.force-enabled': false,
    // The previous compatibility setting changed the compositor only. Canvas
    // and video could still start GPU-backed work in a content/utility process.
    'gfx.canvas.accelerated': !software,
    'gfx.canvas.remote': !software,
    'media.hardware-video-decoding.enabled': !software,
  };
  if (platform === 'win32') {
    // SW-WR + D3D11 still requires the device that failed in the crash log.
    // Force the CPU/GDI compositor instead of the D3D11 software upload path.
    preferences['gfx.webrender.software.d3d11'] = !software;
    preferences['gfx.direct2d.disabled'] = software;
  }
  return preferences;
}
function isGraphicsLaunchCrash(error) {
  const message = String(error?.message || error || '');
  return /Target crashed|browser.*closed|process.*exited/i.test(message) &&
    /FEATURE_FAILURE_D3D11_NO_DEVICE|Failed to launch GPU process|Failed to initialize CompositorD3D11|\[D3D11\].*failed to get compositor device/i.test(message);
}
async function launchWithGraphics(launch, { mode = 'auto', remembered = false, platform = process.platform, beforeRetry = () => {} } = {}) {
  if (!GRAPHICS_MODES.includes(mode)) throw new Error('无效的 Camoufox 图形渲染模式');
  const first = mode === 'software' || (mode === 'auto' && remembered) ? 'software' : 'hardware';
  try { return { context: await launch(first), graphicsMode: first, graphicsFallback: false }; }
  catch (error) {
    if (mode !== 'auto' || first !== 'hardware' || platform !== 'win32' || !isGraphicsLaunchCrash(error)) throw error;
    beforeRetry();
    // Exactly one retry; the closure retains the same profile and proxy.
    return { context: await launch('software'), graphicsMode: 'software', graphicsFallback: true };
  }
}
module.exports = { GRAPHICS_MODES, graphicsPreferences, isGraphicsLaunchCrash, launchWithGraphics };
