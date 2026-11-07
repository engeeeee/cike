'use strict';
const crypto = require('crypto');

function gpuPreset(name, vendor, webgpuVendor) {
  const renderer = process.platform === 'win32' ? `ANGLE (${vendor}, ${name} Direct3D11 vs_5_0 ps_5_0, D3D11)`
    : process.platform === 'darwin' ? `ANGLE (${vendor}, ANGLE Metal Renderer: ${name}, Unspecified Version)`
      : `ANGLE (${vendor}, ${name}, OpenGL 4.5)`;
  return { name, vendor: `Google Inc. (${vendor})`, renderer, webgpuVendor };
}
const GPU_PRESETS = {
  native: { name: '原生显卡', vendor: null, renderer: null },
  'intel-uhd-630': gpuPreset('Intel(R) UHD Graphics 630', 'Intel', 'intel'),
  'intel-iris-xe': gpuPreset('Intel(R) Iris(R) Xe Graphics', 'Intel', 'intel'),
  'nvidia-gtx-1660': gpuPreset('NVIDIA GeForce GTX 1660', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-3060': gpuPreset('NVIDIA GeForce RTX 3060', 'NVIDIA', 'nvidia'),
  'amd-rx-6600': gpuPreset('AMD Radeon RX 6600', 'AMD', 'amd'),
};
const CPU_VALUES = [2, 4, 6, 8, 12, 16, 24, 32];
const MEMORY_VALUES = [0.5, 1, 2, 4, 8];
function hardwareOptions() {
  return { cpus: CPU_VALUES, memories: MEMORY_VALUES,
    gpus: Object.entries(GPU_PRESETS).map(([id, gpu]) => ({ id, name: gpu.name })) };
}
function generateHardware() {
  const choose = list => list[crypto.randomInt(list.length)];
  const gpuPreset = choose(Object.keys(GPU_PRESETS).filter(id => id !== 'native'));
  return { fingerprintMode: 'hardware', hardwareConcurrency: choose([4, 6, 8, 12, 16]), deviceMemory: choose([4, 8]),
    gpuPreset, canvasNoise: true, audioNoise: true, fingerprintSeed: crypto.randomBytes(16).toString('hex') };
}
function completeHardware(profile, patch = {}) {
  if (profile.fingerprintMode !== 'hardware') return profile;
  return { ...profile, hardwareConcurrency: profile.hardwareConcurrency ?? 8, deviceMemory: profile.deviceMemory ?? 8,
    gpuPreset: profile.gpuPreset && profile.gpuPreset !== 'native' ? profile.gpuPreset : (Object.hasOwn(patch, 'gpuPreset') ? patch.gpuPreset : 'intel-uhd-630'),
    fingerprintSeed: profile.fingerprintSeed || crypto.randomBytes(16).toString('hex'),
    canvasNoise: Object.hasOwn(patch, 'canvasNoise') ? patch.canvasNoise : true,
    audioNoise: Object.hasOwn(patch, 'audioNoise') ? patch.audioNoise : true };
}
function validateHardware(profile) {
  if (!CPU_VALUES.includes(profile.hardwareConcurrency)) throw Object.assign(new Error('请选择有效的 CPU 线程数'), { status: 400 });
  if (!MEMORY_VALUES.includes(profile.deviceMemory)) throw Object.assign(new Error('网页内存值必须是 0.5、1、2、4 或 8 GB'), { status: 400 });
  if (!Object.hasOwn(GPU_PRESETS, profile.gpuPreset)) throw Object.assign(new Error('请选择有效的显卡标识'), { status: 400 });
  if (!/^[a-f0-9]{32}$/.test(profile.fingerprintSeed || '')) throw Object.assign(new Error('指纹种子格式无效'), { status: 400 });
  if (typeof profile.canvasNoise !== 'boolean' || typeof profile.audioNoise !== 'boolean') throw Object.assign(new Error('Canvas 和音频选项必须为布尔值'), { status: 400 });
}
function hardwareConfig(profile) {
  validateHardware(profile);
  return { hardwareConcurrency: profile.hardwareConcurrency, deviceMemory: profile.deviceMemory,
    gpu: GPU_PRESETS[profile.gpuPreset], canvasNoise: profile.canvasNoise, audioNoise: profile.audioNoise,
    seed: [0, 8, 16, 24].map(offset => parseInt(profile.fingerprintSeed.slice(offset, offset + 8), 16) >>> 0) };
}
module.exports = { GPU_PRESETS, hardwareOptions, generateHardware, completeHardware, validateHardware, hardwareConfig };
