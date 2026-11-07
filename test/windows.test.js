'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { ZipFile } = require('yazl');
const { defaultDataDirectory, curlRuntime } = require('../src/platform');
const { extractBrowserZip } = require('../src/zip');
const { cftPlatform, downloadUrl, findExecutable, browserVersion } = require('../electron/chromium');

async function fixtureZip(filename, name, contents, mode) {
  const zip = new ZipFile();
  const done = pipeline(zip.outputStream, fs.createWriteStream(filename));
  zip.addBuffer(Buffer.from(contents), name, mode ? { mode } : {});
  zip.end();
  await done;
}

test('Windows stores data under the current user and uses system curl without inherited proxies', () => {
  assert.equal(defaultDataDirectory('win32', { LOCALAPPDATA: 'D:\\Users\\测试 用户\\AppData\\Local' }, 'D:\\Users\\测试 用户'),
    'D:\\Users\\测试 用户\\AppData\\Local\\CIKE');
  const runtime = curlRuntime('win32', { SystemRoot: 'D:\\Windows', PATH: 'untrusted', NO_PROXY: '*', HTTPS_PROXY: 'http://untrusted' });
  assert.equal(runtime.executable, 'D:\\Windows\\System32\\curl.exe');
  assert.equal(runtime.env.SystemRoot, 'D:\\Windows');
  assert.equal(runtime.env.PATH, 'D:\\Windows\\System32');
  assert.equal(runtime.env.NO_PROXY, undefined);
  assert.equal(runtime.env.HTTPS_PROXY, undefined);
});

test('Windows downloads win64 Chromium and rejects unsupported architectures', () => {
  assert.equal(cftPlatform('win32', 'x64'), 'win64');
  assert.match(downloadUrl('win32', 'x64'), /\/win64\/chrome-win64\.zip$/);
  assert.throws(() => cftPlatform('win32', 'arm64'), /x64/);
  assert.equal(cftPlatform('darwin', 'arm64'), 'mac-arm64');
});

test('Windows version detection queries Chromium and always closes its sandboxed probe', async () => {
  const { chromium } = require('playwright');
  let options, closed = 0;
  const replacement = mock.method(chromium, 'launch', async value => {
    options = value;
    return { version: () => '146.0.1.2', close: async () => { closed++; } };
  });
  try {
    assert.equal(await browserVersion('C:\\含 空格\\chrome.exe', 'win32'), '146.0.1.2');
    assert.equal(options.executablePath, 'C:\\含 空格\\chrome.exe');
    assert.equal(options.chromiumSandbox, true);
    assert.equal(options.headless, true);
    assert.equal(closed, 1);
    replacement.mock.mockImplementation(async () => ({ version: () => { throw new Error('probe failed'); }, close: async () => { closed++; } }));
    await assert.rejects(browserVersion('chrome.exe', 'win32'), /probe failed/);
    assert.equal(closed, 2);
  } finally { replacement.mock.restore(); }
});

test('browser ZIP extracts in paths with spaces and Chinese characters and locates chrome.exe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-zip-'));
  try {
    const zip = path.join(root, 'browser.zip'), destination = path.join(root, '测试 用户', '内核');
    await fixtureZip(zip, 'chrome-win64/chrome.exe', 'MZ fixture');
    await extractBrowserZip(zip, destination);
    const executable = findExecutable(destination, 'win32');
    assert.equal(executable, path.join(destination, 'chrome-win64', 'chrome.exe'));
    assert.equal(fs.readFileSync(executable, 'utf8'), 'MZ fixture');
    assert.equal(findExecutable(destination, 'linux'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('browser ZIP rejects traversal, Windows device names, alternate streams and symlinks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-unsafe-zip-'));
  try {
    for (const name of ['con.txt', 'chrome.exe:stream', 'chrome-win64/link']) {
      const zip = path.join(root, 'browser.zip');
      await fixtureZip(zip, name, 'outside', name.endsWith('/link') ? 0o120777 : undefined);
      await assert.rejects(extractBrowserZip(zip, path.join(root, 'extract')), /不安全|符号链接/);
    }
    const zip = path.join(root, 'browser.zip');
    await fixtureZip(zip, 'aa/escape.exe', 'outside');
    const bytes = fs.readFileSync(zip), original = Buffer.from('aa/escape.exe');
    for (let at = bytes.indexOf(original); at !== -1; at = bytes.indexOf(original, at + original.length)) Buffer.from('../escape.exe').copy(bytes, at);
    fs.writeFileSync(zip, bytes);
    await assert.rejects(extractBrowserZip(zip, path.join(root, 'extract')), /invalid relative path|不安全/);
    assert.equal(fs.existsSync(path.join(root, 'escape.exe')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
