'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BUILD, nativeMarker } = require('./nativecore');
const { readJSON, writeJSON, writePrivate } = require('./privatefiles');

const OWNER = '.cike-camoufox.json';
const binary = process.platform === 'win32' ? 'camoufox.exe' : 'camoufox';
const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => !!a && !!b && comparable(a) === comparable(b);
const contains = (parent, child) => { const relative = path.relative(comparable(parent), comparable(child)); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
function canonical(value) {
  const rest = []; let current = path.resolve(value);
  while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) break; rest.unshift(path.basename(current)); current = parent; }
  return path.join(fs.realpathSync(current), ...rest);
}
function versionAt(directory) {
  return fs.readFileSync(path.join(directory, 'application.ini'), 'utf8').match(/^Version=(.+)$/m)?.[1].trim() || '';
}
async function inventory(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (!relative && entry.name === OWNER) continue;
      const name = path.join(relative, entry.name), full = path.join(directory, name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('内核目录包含链接或特殊文件，未执行迁移');
      if (entry.isDirectory()) { files.push({ name, size: 0, directory: true }); await visit(name); }
      else { const stat = await fs.promises.stat(full); files.push({ name, size: stat.size, mode: stat.mode }); }
    }
  }
  await visit(); return files;
}
async function digest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function report(callback, value) { try { callback?.(value); } catch { /* A closed settings window cannot interrupt a file transaction. */ } }
async function renameKernel(from, to) {
  // Windows/antivirus can retain handles briefly after Firefox has exited.
  // Retry only transient sharing/access errors; never replace an existing copy.
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(from, to); return; }
    catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

class NativeStorage {
  constructor(dataDir, { verify, environment = process.env } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.defaultRoot = path.join(this.dataDir, 'browsers');
    this.file = path.join(this.defaultRoot, 'camoufox-storage.json');
    this.verify = verify;
    this.environment = environment;
    this.sizes = new Map();
  }
  load() {
    const value = readJSON(this.file, { format: 1, root: this.defaultRoot, entries: [] });
    if (value.format !== 1 || typeof value.root !== 'string' || !path.isAbsolute(value.root) || !Array.isArray(value.entries)) throw new Error('内核管理配置损坏，原有内核未作修改');
    for (const entry of value.entries) {
      if (!/^[a-f0-9]{32}$/.test(entry.id) || typeof entry.directory !== 'string' || !path.isAbsolute(entry.directory) || typeof entry.version !== 'string') throw new Error('内核管理记录损坏，已阻止文件操作');
    }
    return value;
  }
  save(value) { writeJSON(this.file, value); }
  root() { return this.validateRoot(this.load().root); }
  markerValue() { try { return fs.readFileSync(nativeMarker(this.dataDir), 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; } }
  current() { return this.environment.CIKE_CAMOUFOX_EXECUTABLE || this.markerValue(); }
  select(executable, previous = this.current()) {
    const before = this.current(), marker = this.markerValue();
    if (executable) writePrivate(nativeMarker(this.dataDir), executable + '\n');
    else fs.rmSync(nativeMarker(this.dataDir), { force: true });
    if (same(before, previous) && this.environment.CIKE_CAMOUFOX_EXECUTABLE && (same(before, marker) || this.load().entries.some(entry => same(before, path.join(entry.directory, binary))))) {
      if (executable) this.environment.CIKE_CAMOUFOX_EXECUTABLE = executable;
      else delete this.environment.CIKE_CAMOUFOX_EXECUTABLE;
    }
  }
  assertDirectory(directory) {
    const absolute = path.resolve(directory);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error('不能管理通过链接指向的内核目录');
    const resolved = canonical(absolute);
    if (contains(resolved, canonical(this.dataDir)) || contains(canonical(path.join(this.dataDir, 'profiles')), resolved)) throw new Error('不能将数据或环境目录当作内核删除或迁移');
    return absolute;
  }
  owned(entry) {
    this.assertDirectory(entry.directory);
    if (!path.basename(entry.directory).startsWith('camoufox-')) throw new Error('这不是 CIKE 管理的内核目录');
    if (!fs.existsSync(entry.directory)) return false;
    const owner = readJSON(path.join(entry.directory, OWNER), null);
    if (owner?.owner !== 'CIKE.Camoufox' || owner.id !== entry.id) throw new Error('无法确认内核目录归属，未删除任何文件');
    return true;
  }
  register(directory, version = versionAt(directory)) {
    this.assertDirectory(directory);
    if (!path.basename(directory).startsWith('camoufox-') || !fs.existsSync(path.join(directory, binary))) throw new Error('内核目录结构不正确');
    const value = this.load(), existing = value.entries.find(entry => same(entry.directory, directory));
    if (existing) { this.owned(existing); return existing; }
    const entry = { id: crypto.randomBytes(16).toString('hex'), directory: path.resolve(directory), version, state: 'ready' };
    writeJSON(path.join(directory, OWNER), { owner: 'CIKE.Camoufox', id: entry.id });
    value.entries.push(entry); this.save(value); return entry;
  }
  discover() {
    const value = this.load();
    if (!fs.existsSync(this.defaultRoot)) return;
    for (const item of fs.readdirSync(this.defaultRoot, { withFileTypes: true })) {
      // Adopt only the dedicated directories created by the old installer.
      if (!item.isDirectory() || !/^camoufox-\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?-[A-Za-z0-9]{6}$/.test(item.name)) continue;
      const directory = path.join(this.defaultRoot, item.name);
      if (value.entries.some(entry => same(entry.directory, directory))) continue;
      if (fs.existsSync(path.join(directory, binary)) && fs.existsSync(path.join(directory, 'application.ini'))) this.register(directory);
    }
  }
  async status() {
    this.discover();
    const value = this.load(), current = this.current(), marker = this.markerValue();
    const entries = [];
    for (const entry of value.entries) {
      let exists = fs.existsSync(entry.directory), error = null, owned = false;
      try { owned = this.owned(entry); } catch (reason) { error = reason.message; }
      let bytes = 0;
      if (exists && owned) {
        try {
          if (!this.sizes.has(entry.id)) this.sizes.set(entry.id, (await inventory(entry.directory)).reduce((sum, item) => sum + item.size, 0));
          bytes = this.sizes.get(entry.id);
        } catch (reason) { error = reason.message; }
      }
      entries.push({ ...entry, bytes, exists, error, owned, current: same(current, path.join(entry.directory, binary)), selected: same(marker, path.join(entry.directory, binary)), compatible: entry.version === BUILD && entry.state === 'ready' });
    }
    const external = !!current && !entries.some(entry => entry.current);
    return { root: value.root, current, external, entries, version: BUILD };
  }
  validateRoot(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('请选择完整的内核目录');
    const root = canonical(directory), profiles = canonical(path.join(this.dataDir, 'profiles'));
    if (contains(profiles, root)) throw new Error('内核不能保存在浏览器环境数据目录中');
    for (const entry of this.load().entries) if (contains(canonical(entry.directory), root)) throw new Error('请选择内核文件夹之外的位置，避免复制进自身');
    if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) throw new Error('所选位置不是文件夹');
    return root;
  }
  async changeRoot(directory, onProgress) {
    this.discover();
    const root = this.validateRoot(directory), original = this.load(), current = this.current();
    const entry = original.entries.find(item => same(current, path.join(item.directory, binary)) && item.version === BUILD && item.state === 'ready');
    if (!entry || same(path.dirname(entry.directory), root)) {
      this.save({ ...original, root });
      return { moved: false, external: !!current && !entry, root };
    }
    this.owned(entry);
    // The chosen parent may hold unrelated files; preserve its permissions.
    fs.mkdirSync(root, { recursive: true });
    const files = await inventory(entry.directory), total = files.reduce((sum, file) => sum + file.size, 0);
    const staging = fs.mkdtempSync(path.join(root, 'camoufox-copy-'));
    let target = staging, committed = false;
    const beforeMarker = this.markerValue(), beforeEnvironment = this.environment.CIKE_CAMOUFOX_EXECUTABLE;
    try {
      let done = 0;
      for (const file of files) {
        const destination = path.join(staging, file.name);
        if (file.directory) { await fs.promises.mkdir(destination, { recursive: true }); continue; }
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(path.join(entry.directory, file.name), destination);
        if (process.platform !== 'win32') await fs.promises.chmod(destination, file.mode & 0o777);
        done += file.size; report(onProgress, { phase: '正在复制内核', pct: total ? Math.floor(done / total * 45) : 45 });
      }
      done = 0;
      for (const file of files) {
        if (file.directory) continue;
        const [before, after] = await Promise.all([digest(path.join(entry.directory, file.name)), digest(path.join(staging, file.name))]);
        if (before !== after) throw new Error('内核文件校验失败，旧位置保持不变');
        done += file.size; report(onProgress, { phase: '正在校验文件', pct: 45 + (total ? Math.floor(done / total * 45) : 45) });
      }
      report(onProgress, { phase: '正在验证内核启动', pct: 90 });
      if (!this.verify) throw new Error('缺少内核启动验证器');
      await this.verify(path.join(staging, binary));
      target = path.join(root, `camoufox-${BUILD}-${crypto.randomBytes(3).toString('hex')}`);
      await renameKernel(staging, target);
      const added = { id: crypto.randomBytes(16).toString('hex'), directory: target, version: BUILD, state: 'ready' };
      writeJSON(path.join(target, OWNER), { owner: 'CIKE.Camoufox', id: added.id });
      this.save({ ...original, root, entries: [...original.entries, added] });
      this.select(path.join(target, binary));
      committed = true;
      report(onProgress, { phase: '已切换到新位置，旧副本可在列表中删除', pct: 100 });
      return { moved: true, root, executable: path.join(target, binary), previous: entry.id };
    } catch (error) {
      // The original binary and every profile remain untouched until commit.
      this.save(original);
      if (beforeMarker) writePrivate(nativeMarker(this.dataDir), beforeMarker + '\n');
      else fs.rmSync(nativeMarker(this.dataDir), { force: true });
      if (beforeEnvironment === undefined) delete this.environment.CIKE_CAMOUFOX_EXECUTABLE;
      else this.environment.CIKE_CAMOUFOX_EXECUTABLE = beforeEnvironment;
      throw error;
    } finally {
      if (!committed) await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
    }
  }
  async deletionPlan(id) {
    const status = await this.status(), entry = status.entries.find(item => item.id === id);
    if (!entry) throw new Error('内核记录不存在，请刷新列表');
    if (entry.exists) this.owned(entry);
    let fallback = null;
    if (entry.current || entry.selected) for (const item of status.entries) {
      if (item.id === id || !item.owned || !item.exists || !item.compatible) continue;
      try { await this.verify(path.join(item.directory, binary)); fallback = item; break; } catch { /* Try another verified copy before uninstalling the final usable version. */ }
    }
    return { entry, fallback, needsDownload: entry.current && !fallback };
  }
  async remove(id) {
    const { entry, fallback, needsDownload } = await this.deletionPlan(id), original = this.load();
    const marker = this.markerValue(), oldEnvironment = this.environment.CIKE_CAMOUFOX_EXECUTABLE;
    let target = entry.directory, renamed = false;
    try {
      if (entry.current || entry.selected) this.select(fallback ? path.join(fallback.directory, binary) : '', path.join(entry.directory, binary));
      if (entry.exists && entry.state !== 'deleting') {
        target = path.join(path.dirname(entry.directory), 'camoufox-delete-' + entry.id);
        await renameKernel(entry.directory, target); renamed = true;
      }
      const pending = { ...original.entries.find(item => item.id === id), directory: target, state: 'deleting' };
      this.save({ ...original, entries: original.entries.map(item => item.id === id ? pending : item) });
    } catch (error) {
      if (renamed) await renameKernel(target, entry.directory);
      if (entry.current || entry.selected) {
        if (marker) writePrivate(nativeMarker(this.dataDir), marker + '\n');
        else fs.rmSync(nativeMarker(this.dataDir), { force: true });
        if (oldEnvironment === undefined) delete this.environment.CIKE_CAMOUFOX_EXECUTABLE;
        else this.environment.CIKE_CAMOUFOX_EXECUTABLE = oldEnvironment;
      }
      throw error;
    }
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      this.save({ ...this.load(), entries: this.load().entries.filter(item => item.id !== id) });
      this.sizes.delete(id);
    } catch (error) {
      if (fs.existsSync(target)) writeJSON(path.join(target, OWNER), { owner: 'CIKE.Camoufox', id });
      throw new Error('部分内核文件仍被占用，剩余文件已保留在列表中，可关闭相关进程后重试：' + error.message);
    }
    return { removed: id, needsDownload, fallback: fallback?.id || null };
  }
}

module.exports = { NativeStorage, binary, inventory, renameKernel };
