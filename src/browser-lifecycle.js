'use strict';

// Every timeout observes the original promise too, so a late rejection cannot
// become an unhandled rejection during shutdown.
async function within(task, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task).then(value => ({ completed: true, value })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ completed: false }), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
function ownedBrowser(context) {
  // These are in-process Playwright instances, pinned in package-lock.json.
  // Never search for/terminate a process by its executable name.
  try { return context._connection.toImpl(context)._browser.options.browserProcess; }
  catch { return null; }
}
async function stopContext(context, timeout = 4000) {
  if (!context) return;
  const owner = ownedBrowser(context);
  try {
    if ((await within(() => context.close(), timeout)).completed) {
      if (!owner?.process || owner.process.exitCode != null || owner.process.signalCode != null) return;
      // A disposed protocol context alone does not prove that its OS process
      // exited. Allow its normal shutdown to finish before escalating.
      if ((await within(() => new Promise(resolve => owner.process.once('exit', resolve)), 1000)).completed) return;
    }
  }
  catch (error) { if (!owner) throw error; }
  await forceStopContext(context, owner);
}
async function forceStopContext(context, owner = ownedBrowser(context)) {
  if (!owner?.process?.pid || typeof owner.kill !== 'function') throw new Error('浏览器关闭超时，请稍后重试');
  context._cikeOnForcedStop?.();
  await within(() => owner.kill(), 2000);
  if (owner.process.exitCode == null && owner.process.signalCode == null) throw new Error('浏览器进程仍在退出，请稍后重试');
}
module.exports = { within, ownedBrowser, stopContext, forceStopContext };
