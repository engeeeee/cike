'use strict';
// Privileged extension background only: no content scripts or web-accessible
// resources. Uses Firefox's real window API; never patches a page API.
const observed = new Map();
let working = false;
async function bridge(method = 'GET', value) {
  const response = await fetch(cikeWindowBridge.url, { method, headers: { 'Content-Type': 'application/json', 'X-CIKE-Window-Token': cikeWindowBridge.token },
    ...(value ? { body: JSON.stringify(value) } : {}) });
  if (!response.ok) throw new Error('CIKE window bridge: ' + response.status);
  return response.json();
}
async function synchronize() {
  if (working) return;
  working = true;
  try {
    const windows = (await browser.windows.getAll()).filter(window => window.type === 'normal' || window.type === 'popup');
    // Capture a manual F11/maximize change before sizing a newly created window.
    for (const window of windows) {
      if (!observed.has(window.id) || window.state === 'minimized') continue;
      if (observed.get(window.id) !== window.state) await bridge('PATCH', { state: window.state });
      observed.set(window.id, window.state);
    }
    const desired = await bridge();
    for (const window of windows) {
      if (!observed.has(window.id)) {
        await browser.windows.update(window.id, { state: desired.state });
        observed.set(window.id, desired.state);
      }
    }
    const ids = new Set(windows.map(window => window.id));
    for (const id of observed.keys()) if (!ids.has(id)) observed.delete(id);
  } catch (error) { console.error(error.message); }
  finally { working = false; }
}
browser.windows.onCreated.addListener(synchronize);
browser.windows.onRemoved.addListener(id => observed.delete(id));
if (browser.windows.onBoundsChanged) browser.windows.onBoundsChanged.addListener(synchronize);
setInterval(synchronize, 500);
synchronize();
