'use strict';
const { hardwareConfig } = require('./hardware');
const { hardwareScript } = require('./hardware-script');
const records = new WeakMap(), patched = new WeakSet();
const workerTypes = new Set(['worker', 'shared_worker', 'service_worker']);

function hookSession(session, record) {
  session.prependListener('Target.attachedToTarget', event => record.targets.set(event.sessionId, event.targetInfo.type));
}
function patchProtocol(prototype) {
  if (patched.has(prototype)) return;
  patched.add(prototype);
  const create = prototype.createChildSession, send = prototype.send, detach = prototype.detach;
  prototype.createChildSession = function (...args) {
    const child = Reflect.apply(create, this, args), record = records.get(this._connection);
    if (record) hookSession(child, record);
    return child;
  };
  prototype.send = function (method, params) {
    const record = records.get(this._connection);
    if (!record || method !== 'Runtime.runIfWaitingForDebugger' || !workerTypes.has(record.targets.get(this._sessionId)) || record.initialized.has(this)) {
      return Reflect.apply(send, this, [method, params]);
    }
    record.initialized.add(this);
    // Queue before resume, without awaiting: service-worker startup cannot
    // answer Runtime commands until it receives runIfWaitingForDebugger.
    // Chromium processes these queued commands before its first site script.
    const enabled = Reflect.apply(send, this, ['Runtime.enable']);
    const installed = Reflect.apply(send, this, ['Runtime.evaluate', { expression: record.script, disableBreaks: true }]);
    const network = Reflect.apply(send, this, ['Network.enable']);
    const headers = Reflect.apply(send, this, ['Network.setExtraHTTPHeaders', { headers: record.headers }]);
    const resumed = Reflect.apply(send, this, [method, params]);
    return Promise.all([enabled, installed, network, headers, resumed]).then(([, result, , , response]) => {
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Worker hardware configuration failed');
      return response;
    }).catch(error => {
      record.failed(error);
      throw error;
    });
  };
  prototype.detach = function (...args) {
    const record = records.get(this._connection);
    // Playwright does not expose SharedWorker objects and normally detaches
    // immediately. Keep its session so memory hints remain applied to fetch.
    if (record && record.targets.get(this._sessionId) === 'shared_worker') return this.send('Runtime.runIfWaitingForDebugger');
    return Reflect.apply(detach, this, args);
  };
}

async function installHardwareContext(context, profile) {
  if (profile.fingerprintMode !== 'hardware') return;
  // This narrowly scoped adapter is tested against the pinned Playwright
  // version. Public worker events run after worker code and cannot guarantee
  // first-statement consistency; no remote debugging port is opened.
  const version = require('playwright-core/package.json').version;
  const server = context._connection?.toImpl?.(context);
  const connection = server?._browser?._connection;
  if (version !== '1.64.1' || !connection?.rootSession || !(connection._sessions instanceof Map)) {
    throw new Error('硬件模拟与当前浏览器控制版本不兼容，请切换原生模式');
  }
  const config = hardwareConfig(profile), script = hardwareScript(config);
  const record = { script, headers: { 'Device-Memory': String(config.deviceMemory), 'Sec-CH-Device-Memory': String(config.deviceMemory) },
    targets: new Map(), initialized: new WeakSet(), closed: false,
    failed(error) {
      if (record.closed) return;
      console.error('[CIKE] hardware worker initialization failed:', error.message);
      context.close().catch(() => {});
    } };
  records.set(connection, record);
  patchProtocol(Object.getPrototypeOf(connection.rootSession));
  for (const session of connection._sessions.values()) hookSession(session, record);
  context.once('close', () => { record.closed = true; records.delete(connection); });
  await context.addInitScript({ content: script });
  await Promise.all(context.pages().map(page => page.evaluate(script)));
}

module.exports = { installHardwareContext };
