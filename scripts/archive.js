'use strict';
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { ZipFile } = require('yazl');

async function zipDirectory(directory, filename) {
  const zip = new ZipFile();
  const done = pipeline(zip.outputStream, fs.createWriteStream(filename));
  function add(current, prefix) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = path.join(current, item.name), target = `${prefix}/${item.name}`;
      if (item.isDirectory()) add(source, target);
      else if (item.isFile()) zip.addFile(source, target, { mode: 0o100644 });
      else throw new Error(`Cannot package a special file: ${source}`);
    }
  }
  try { add(directory, path.basename(directory)); zip.end(); }
  catch (error) { zip.outputStream.destroy(error); }
  await done;
}

module.exports = { zipDirectory };
