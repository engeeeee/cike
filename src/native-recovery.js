'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJSON, writeJSON, privateDirectory } = require('./privatefiles');
const REVISION = 1;
const CACHE_FILES = ['startupCache', 'shader-cache', 'addonStartup.json.lz4', 'xulstore.json'];
const stateFile = directory => path.join(directory, '.cike-runtime.json');

function prepareProfile(directory) {
  const file = stateFile(directory);
  const previous = readJSON(file, {});
  // Older builds and abnormal exits may leave startup/compositor/extension
  // caches behind. Move only explicitly regenerable files; keep login stores,
  // permissions, extensions, prefs.js, user.js and session data intact.
  const repair = previous.revision !== REVISION || previous.unclean || previous.crashed;
  let backup = null;
  if (repair) {
    for (const name of CACHE_FILES) {
      const source = path.join(directory, name);
      if (!fs.existsSync(source)) continue;
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error('内核缓存不能是符号链接');
      if (!backup) {
        const parent = path.join(directory, 'cike-recovery'); privateDirectory(parent);
        backup = path.join(parent, Date.now() + '-' + crypto.randomBytes(4).toString('hex')); privateDirectory(backup);
      }
      fs.renameSync(source, path.join(backup, name));
    }
  }
  writeJSON(file, { revision: REVISION, unclean: true, crashed: false });
  let crashed = false;
  return {
    repaired: !!backup,
    crash() { crashed = true; writeJSON(file, { revision: REVISION, unclean: true, crashed: true }); },
    close() { writeJSON(file, { revision: REVISION, unclean: false, crashed }); },
  };
}
module.exports = { prepareProfile, CACHE_FILES };
