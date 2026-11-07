'use strict';
let kernelUiBusy = false;
let nativeLibrary = null;
function syncKernelButtons() {
  const locked = kernelUiBusy || nativeLibrary?.busy || nativeLibrary?.inUse;
  for (const button of document.querySelectorAll('.native-storage-action')) button.disabled = !!locked || button.dataset.readonly === 'true';
  document.getElementById('btn-download-native').disabled = !!locked || !!state.nativeCore?.installed;
  document.getElementById('btn-download-browser').disabled = !!locked || !!(state.chromium?.installed && !state.chromium?.updateAvailable);
}
function setKernelUiBusy(value) { kernelUiBusy = value; syncKernelButtons(); }
function nativeBytes(value) { return value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' : (value / 1024 ** 2).toFixed(1) + ' MB'; }
async function refreshNativeLibrary() {
  try {
    nativeLibrary = await window.lfb.nativeStorageStatus();
    document.getElementById('native-storage-root').textContent = nativeLibrary.root;
    document.getElementById('native-storage-notice').textContent = nativeLibrary.inUse ? '请先关闭所有浏览器环境，再迁移或删除内核。' : nativeLibrary.busy ? '内核操作正在进行，请稍候。' :
      nativeLibrary.external ? '当前使用外部指定的内核：' + nativeLibrary.current + '。外部内核只读；更改位置仅影响后续下载。' : '可将内核迁移到其他磁盘，或删除不用的副本。';
    document.getElementById('native-storage-list').innerHTML = nativeLibrary.entries.length ? nativeLibrary.entries.map(entry => {
      const readonly = entry.exists && (!entry.owned || !!entry.error);
      const label = entry.state === 'deleting' ? '待清理文件' : entry.current ? '当前使用' : '未使用副本';
      return `<div class="native-storage-entry" data-native-id="${esc(entry.id)}"><div>${esc(entry.version)} · ${label} · ${entry.exists ? nativeBytes(entry.bytes) : '文件已不存在'}</div>
        <div class="storage-path">${esc(entry.directory)}</div>${entry.error ? `<p class="hint">${esc(entry.error)}</p>` : ''}
        <div class="row"><button class="btn small" data-native-open="${esc(entry.id)}" ${entry.exists ? '' : 'disabled'}>打开目录</button>
        <button class="btn small danger-ghost native-storage-action" data-native-remove="${esc(entry.id)}" data-readonly="${readonly}">${entry.current ? '卸载此内核' : entry.exists ? '删除副本' : '移除记录'}</button></div></div>`;
    }).join('') : '<p class="hint">没有由 CIKE 管理的内核副本。</p>';
    for (const button of document.querySelectorAll('[data-native-open]')) button.onclick = () => openNativeFolder(button.dataset.nativeOpen);
    for (const button of document.querySelectorAll('[data-native-remove]')) button.onclick = () => runNativeStorage(() => window.lfb.nativeStorageRemove(button.dataset.nativeRemove), 'delete');
  } catch (error) { document.getElementById('native-storage-notice').textContent = '读取内核目录失败：' + error.message; }
  syncKernelButtons();
}
async function openNativeFolder(id) {
  try { const result = await window.lfb.nativeStorageOpen(id); if (!result.ok) throw new Error(result.error); }
  catch (error) { toast(error.message, true); }
}
async function runNativeStorage(operation, action) {
  if (kernelUiBusy) return;
  setKernelUiBusy(true);
  const progress = document.getElementById('native-storage-progress');
  document.getElementById('native-storage-phase').textContent = '';
  try {
    const result = await operation();
    if (!result.ok) throw new Error(result.error);
    if (!result.canceled) toast(action === 'delete' ? result.needsDownload ? '内核已卸载，环境和登录数据保留；再次使用前请下载内核' : '内核文件已删除，环境数据保留' :
      result.moved ? '内核已迁移并验证，旧副本保留，可在列表中删除' : '后续下载位置已保存');
  } catch (error) { toast('内核操作失败：' + error.message, true); }
  finally {
    progress.classList.add('hidden');
    setKernelUiBusy(false);
    await Promise.all([refreshNativeStatus(), refreshChromiumStatus(), refreshNativeLibrary()]);
    syncKernelButtons();
  }
}
window.lfb.onNativeStorageProgress(value => {
  const progress = document.getElementById('native-storage-progress'); progress.classList.remove('hidden');
  progress.querySelector('.bar').style.width = Math.max(0, Math.min(100, value.pct || 0)) + '%';
  document.getElementById('native-storage-phase').textContent = value.phase || '';
});
document.getElementById('btn-native-location').onclick = () => runNativeStorage(() => window.lfb.nativeStorageChange(), 'move');
document.getElementById('btn-native-folder').onclick = () => openNativeFolder('root');
document.getElementById('btn-native-refresh').onclick = refreshNativeLibrary;
