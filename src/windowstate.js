'use strict';
const states = new Set(['normal', 'maximized', 'fullscreen']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Window state belongs to native browser windows, not tabs or page viewports.
// Remember changes made through F11/title-bar buttons across environments.
class WindowStateManager {
  constructor(settings) {
    this.settings = settings;
    this.current = 'maximized';
    this.contexts = new Set();
    this.pending = Promise.resolve();
  }
  desired() {
    const settings = this.settings?.get();
    return settings?.browserWindowMode && settings.browserWindowMode !== 'remember'
      ? settings.browserWindowMode : settings?.browserWindowState || this.current;
  }
  enqueue(action) {
    const operation = this.pending.then(action);
    this.pending = operation.catch(() => {});
    return operation;
  }
  async sample() {
    for (const entry of this.contexts) {
      if (entry.closed) continue;
      for (const record of entry.windows.values()) {
        const session = [...record.pages].find(([page]) => !page.isClosed())?.[1];
        if (!session) continue;
        let state;
        try { state = (await session.send('Browser.getWindowBounds', { windowId: record.id })).bounds.windowState; }
        catch { continue; } // A window can close while it is being sampled.
        if (!states.has(state) || record.state === state) continue;
        record.state = state;
        this.current = state;
        this.settings?.rememberWindowState(state);
      }
    }
  }
  capture() { return this.enqueue(() => this.sample()); }
  async setState(session, windowId, desired) {
    let { bounds } = await session.send('Browser.getWindowBounds', { windowId });
    if (bounds.windowState === desired) return;
    const change = async state => {
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
      for (let attempt = 0; attempt < 60; attempt++) {
        bounds = (await session.send('Browser.getWindowBounds', { windowId })).bounds;
        if (bounds.windowState === state) return;
        await wait(50);
      }
      throw new Error('浏览器窗口状态未能完成切换');
    };
    // Wait for the native transition before asking to enter another state.
    if (bounds.windowState !== 'normal') {
      await change('normal');
      if (desired === 'normal') return;
    }
    await change(desired);
  }
  async attach(context) {
    const entry = { context, windows: new Map(), closed: false };
    this.contexts.add(entry);
    const register = page => this.enqueue(async () => {
      if (entry.closed || page.isClosed()) return;
      await this.sample();
      const session = await context.newCDPSession(page);
      let info;
      try { info = await session.send('Browser.getWindowForTarget'); }
      catch (error) { await session.detach().catch(() => {}); if (page.isClosed() || entry.closed) return; throw error; }
      let record = entry.windows.get(info.windowId);
      const isNewWindow = !record;
      if (!record) {
        record = { id: info.windowId, state: info.bounds.windowState, pages: new Map() };
        entry.windows.set(info.windowId, record);
      }
      record.pages.set(page, session);
      page.once('close', () => {
        record.pages.delete(page);
        if (!record.pages.size) entry.windows.delete(record.id);
        session.detach().catch(() => {});
      });
      // A new tab shares the window's existing state; never resize it.
      if (isNewWindow) {
        const desired = this.desired();
        await this.setState(session, record.id, desired);
        record.state = desired;
      }
    });
    context.on('page', page => { register(page).catch(error => { if (!page.isClosed() && !entry.closed) console.error('[CIKE] window:', error.message); }); });
    context.once('close', () => {
      entry.closed = true;
      this.contexts.delete(entry);
      if (!this.contexts.size) { clearInterval(this.timer); this.timer = null; }
    });
    for (const page of context.pages()) await register(page);
    if (!this.timer && !entry.closed) {
      this.timer = setInterval(() => { this.capture().catch(error => console.error('[CIKE] window state:', error.message)); }, 500);
      this.timer.unref();
    }
  }
}

module.exports = { WindowStateManager };
