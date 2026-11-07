'use strict';
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

// Chromium's Windows/Linux archives contain regular files and directories.
// Stream extraction avoids buffering the expanded browser in memory. macOS
// bundles use symlinks and are still extracted with the system unzip.
async function extractBrowserZip(filename, destination) {
  const root = path.resolve(destination);
  const archive = await yauzl.openPromise(filename, { strictFileNames: true });
  let total = 0;
  try {
    for await (const entry of archive.eachEntry()) {
      const parts = entry.fileName.replace(/\/$/, '').split('/');
      if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error('内核压缩包包含不安全的路径');
      }
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) throw new Error('内核压缩包不能包含符号链接或特殊文件');
      total += entry.uncompressedSize;
      if (total > 3 * 1024 * 1024 * 1024) throw new Error('内核解压后异常过大');
      const target = path.join(root, ...parts);
      if (entry.fileName.endsWith('/')) await fs.promises.mkdir(target, { recursive: true });
      else {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const input = await archive.openReadStreamPromise(entry);
        const mode = (entry.externalFileAttributes >>> 16) & 0o111 ? 0o700 : 0o600;
        await pipeline(input, fs.createWriteStream(target, { flags: 'wx', mode }));
      }
    }
  } finally { archive.close(); }
}

module.exports = { extractBrowserZip };
