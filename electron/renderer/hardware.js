'use strict';
let hardwareOptionsPromise;
async function mountHardware(root, prefix, profile = {}) {
  if (!hardwareOptionsPromise) hardwareOptionsPromise = api('/api/fingerprints/options');
  const options = await hardwareOptionsPromise;
  if (!root.isConnected) return;
  const hardware = profile.fingerprintMode === 'hardware';
  const choices = (values, selected) => values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
  root.innerHTML = `
    <div class="field"><label>指纹策略</label><select id="${prefix}-fingerprint-mode" class="input"><option value="native" ${hardware ? '' : 'selected'}>原生一致</option><option value="hardware" ${hardware ? 'selected' : ''}>硬件模拟（软件层）</option></select></div>
    <div id="${prefix}-hardware-fields" class="${hardware ? '' : 'hidden'}">
      <div class="field-row"><div class="field"><label>CPU 线程数</label><select id="${prefix}-hardware-cpu" class="input">${choices(options.cpus, profile.hardwareConcurrency || 8)}</select></div>
      <div class="field"><label>网页内存值（GB）</label><select id="${prefix}-hardware-memory" class="input">${choices(options.memories, profile.deviceMemory || 8)}</select></div></div>
      <div class="field"><label>显卡标识</label><select id="${prefix}-hardware-gpu" class="input">${options.gpus.map(gpu => `<option value="${esc(gpu.id)}" ${gpu.id === (hardware ? profile.gpuPreset : 'intel-uhd-630') ? 'selected' : ''}>${esc(gpu.name)}</option>`).join('')}</select></div>
      <div class="field-row"><div class="field"><label>Canvas 读取</label><select id="${prefix}-hardware-canvas" class="input"><option value="yes" ${!hardware || profile.canvasNoise ? 'selected' : ''}>按环境固定处理</option><option value="no" ${hardware && !profile.canvasNoise ? 'selected' : ''}>原生输出</option></select></div>
      <div class="field"><label>音频读取</label><select id="${prefix}-hardware-audio" class="input"><option value="yes" ${!hardware || profile.audioNoise ? 'selected' : ''}>按环境固定处理</option><option value="no" ${hardware && !profile.audioNoise ? 'selected' : ''}>原生输出</option></select></div></div>
      <input type="hidden" id="${prefix}-fingerprint-seed" value="${esc(profile.fingerprintSeed || '')}">
      <div class="row"><span id="${prefix}-hardware-id" class="hint">${profile.fingerprintSeed ? '指纹编号 ' + esc(profile.fingerprintSeed.slice(0, 8)) : '保存时生成固定指纹编号'}</span><button type="button" id="${prefix}-hardware-generate" class="btn small">生成另一组</button></div>
      <p class="hint">修改后重开环境生效；重新生成会改变指纹。内存为网页暴露的近似值，最高 8 GB。显卡标识不改变实际渲染能力。</p>
    </div>
    <p class="hint">硬件模拟覆盖 CPU/内存、显卡标识和固定 Canvas/音频输出，属于可被识别的软件模拟。系统、浏览器 UA、字体及窗口尺寸继续使用真实环境。</p>`;
  const field = id => root.querySelector('#' + prefix + '-' + id);
  field('fingerprint-mode').onchange = () => field('hardware-fields').classList.toggle('hidden', field('fingerprint-mode').value !== 'hardware');
  field('hardware-generate').onclick = async event => {
    event.target.disabled = true;
    try {
      const { fingerprint } = await api('/api/fingerprints/generate', { method: 'POST', body: '{}' });
      if (!root.isConnected) return;
      field('fingerprint-mode').value = 'hardware'; field('hardware-fields').classList.remove('hidden');
      field('hardware-cpu').value = fingerprint.hardwareConcurrency;
      field('hardware-memory').value = fingerprint.deviceMemory;
      field('hardware-gpu').value = fingerprint.gpuPreset;
      field('hardware-canvas').value = field('hardware-audio').value = 'yes';
      field('fingerprint-seed').value = fingerprint.fingerprintSeed;
      field('hardware-id').textContent = '指纹编号 ' + fingerprint.fingerprintSeed.slice(0, 8);
    } catch (error) { toast(error.message, true); }
    finally { event.target.disabled = false; }
  };
}
function readHardware(root, prefix, fallback = {}) {
  const field = id => root.querySelector('#' + prefix + '-' + id);
  const mode = field('fingerprint-mode')?.value || (fallback.fingerprintMode === 'hardware' ? 'hardware' : 'native');
  if (mode === 'native') return { fingerprintMode: 'native', hardwareConcurrency: null, deviceMemory: null, gpuPreset: 'native', canvasNoise: false, audioNoise: false, fingerprintSeed: fallback.fingerprintSeed || null };
  return { fingerprintMode: 'hardware', hardwareConcurrency: Number(field('hardware-cpu')?.value || fallback.hardwareConcurrency),
    deviceMemory: Number(field('hardware-memory')?.value || fallback.deviceMemory), gpuPreset: field('hardware-gpu')?.value || fallback.gpuPreset,
    canvasNoise: field('hardware-canvas') ? field('hardware-canvas').value === 'yes' : fallback.canvasNoise,
    audioNoise: field('hardware-audio') ? field('hardware-audio').value === 'yes' : fallback.audioNoise,
    fingerprintSeed: field('fingerprint-seed')?.value || fallback.fingerprintSeed || null };
}
