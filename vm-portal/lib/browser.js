/*
 * Microsoft Edge driven by Playwright, standing in for the extension's browser:
 *  - pages are numbered like tabs;
 *  - one init script installs the engine (zk-bridge, zk-dom, selectors, content + page/bootstrap.js)
 *    in a page once the portal says the page matches a registered content script;
 *  - the first, blank page stays as a status page and is used to check that Backoffice is reachable
 *    through Edge's own network settings;
 *  - if the window is closed, Edge is started again.
 * The Edge profile (and with it the Backoffice SSO session) lives in its own folder.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ENGINE_FILES = ['scripts/zk-bridge.js', 'scripts/zk-dom.js', 'scripts/selectors.js', 'scripts/content.js'];
// Keep pages working while the window is hidden behind others or the RDP session is disconnected.
const EDGE_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
];
const STATUS_PAGE = `<!doctype html><title>Promo Tag Portal</title>
<body style="font:15px/1.5 Segoe UI,sans-serif;margin:40px;color:#111827">
<h1 style="font-size:20px">Promo Tag Portal is running</h1>
<p>Keep this Edge window open: the portal runs Backoffice in its other tabs.</p>
<p>To sign in to Backoffice (first time, or when the session expired), open a new tab here, go to the
Backoffice URL and sign in. Then close that tab.</p></body>`;

function engineInitScript(extDir) {
  const files = ENGINE_FILES.map((f) => [f, path.join(extDir, f)]).concat([['page/bootstrap.js', path.join(__dirname, '..', 'page', 'bootstrap.js')]]);
  const code = files.map(([name, file]) => `// ---- ${name}\n${fs.readFileSync(file, 'utf8')}`).join('\n');
  return `(() => {
  if (window.top !== window || window.__ptaeVmInstall) return;
  let installed = false;
  window.__ptaeVmInstall = () => {
    if (installed) return true;
    installed = true;
${code}
    return true;
  };
  const check = () => window.__ptaeVmSend({ type: 'VM_PAGE', href: location.href })
    .then((r) => { if (r && r.install) window.__ptaeVmInstall(); }, () => {});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check, { once: true });
  else check();
})();`;
}

class EdgeHost {
  /**
   * opts: { extDir, profileDir, channel, headless, viewport,
   *         onPageMessage(tabId, page, frame, msg), onTabCreated(id, url), onTabUpdated(id, url), onTabRemoved(id) }
   */
  constructor(opts) {
    this.opts = opts;
    this.script = engineInitScript(opts.extDir);
    this.context = null;
    this.starting = null;
    this.statusPage = null;
    this.tabs = new Map();
    this.ids = new WeakMap();
    this.nextId = 1;
    this.activeId = null;
    this.stopping = false;
  }

  start() {
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async launch() {
    const o = this.opts;
    const context = await chromium.launchPersistentContext(o.profileDir, {
      channel: o.channel,
      headless: o.headless,
      viewport: o.viewport,
      args: EDGE_ARGS,
    });
    this.context = context;
    await context.exposeBinding('__ptaeVmSend', ({ page, frame }, msg) => o.onPageMessage(this.ids.get(page), page, frame, msg));
    await context.addInitScript({ content: this.script });
    const [first] = context.pages();
    this.statusPage = first || null;
    if (first) await first.setContent(STATUS_PAGE).catch(() => {});
    context.pages().forEach((page) => this.track(page));
    context.on('page', (page) => this.track(page));
    context.on('close', () => this.closed(context));
  }

  async ready() {
    if (!this.context) await this.start();
    return this.context;
  }

  track(page) {
    if (page === this.statusPage || this.ids.has(page)) return;
    const id = this.nextId++;
    this.ids.set(page, id);
    this.tabs.set(id, page);
    if (this.activeId == null) this.activeId = id;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.opts.onTabUpdated(id, page.url());
    });
    page.on('close', () => this.removed(id));
    this.opts.onTabCreated(id, page.url());
  }

  removed(id) {
    if (!this.tabs.delete(id)) return;
    if (this.activeId === id) this.activeId = this.tabs.size ? this.tabs.keys().next().value : null;
    this.opts.onTabRemoved(id);
  }

  closed(context) {
    if (context !== this.context) return;
    this.context = null;
    this.statusPage = null;
    [...this.tabs.keys()].forEach((id) => this.removed(id));
    if (this.stopping) return;
    console.warn('Edge was closed. Starting it again in 3 s…');
    setTimeout(() => this.start().catch((err) => console.error(`Edge did not start: ${err.message}`)), 3000);
  }

  async stop() {
    this.stopping = true;
    if (this.context) await this.context.close().catch(() => {});
  }

  page(id) {
    const page = this.tabs.get(id);
    if (!page) throw new Error(`No tab with id: ${id}.`);
    return page;
  }

  info(id) {
    const page = this.tabs.get(id);
    return page ? { id, windowId: 1, active: id === this.activeId, url: page.url(), status: 'complete' } : null;
  }

  list() {
    return [...this.tabs.keys()].map((id) => this.info(id));
  }

  async create(url, active) {
    const context = await this.ready();
    const page = await context.newPage();
    this.track(page);
    const id = this.ids.get(page);
    if (active !== false) this.activeId = id;
    if (url) page.goto(url, { waitUntil: 'commit', timeout: 120000 }).catch(() => {});
    return this.info(id);
  }

  async update(id, props = {}) {
    const page = this.page(id);
    if (props.active) {
      this.activeId = id;
      await page.bringToFront().catch(() => {});
    }
    if (props.url) page.goto(props.url, { waitUntil: 'commit', timeout: 120000 }).catch(() => {});
    return this.info(id);
  }

  /** Delivers a BG_* command to the page's engine (like chrome.tabs.sendMessage). */
  async command(id, msg) {
    const resp = await this.page(id).evaluate((m) => (window.__ptaeVmCommand ? window.__ptaeVmCommand(m) : '__none__'), msg);
    if (resp === '__none__') throw new Error('Could not establish connection. Receiving end does not exist.');
    return resp;
  }

  /** Installs the engine now (like chrome.scripting.executeScript). */
  async install(id) {
    return this.page(id).evaluate(() => !!(window.__ptaeVmInstall && window.__ptaeVmInstall()));
  }

  /** Like chrome.tabs.captureVisibleTab: options.format 'jpeg' (with options.quality) or 'png'. */
  async screenshotActive(options = {}) {
    if (this.activeId == null) throw new Error('No tab to capture.');
    const jpeg = options.format === 'jpeg';
    const shot = await this.page(this.activeId).screenshot(jpeg ? { type: 'jpeg', quality: options.quality || 90 } : { type: 'png' });
    return `data:image/${jpeg ? 'jpeg' : 'png'};base64,${shot.toString('base64')}`;
  }

  /** Whether Edge can reach `url` (true/false), or null when there is no page to test from. */
  async canReach(url, ms) {
    const page = this.statusPage && !this.statusPage.isClosed() ? this.statusPage : null;
    if (!page) return null;
    return page
      .evaluate(async ({ u, timeout }) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeout);
        try {
          await fetch(u, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
          return true;
        } catch (_) {
          return false;
        } finally {
          clearTimeout(timer);
        }
      }, { u: url, timeout: ms })
      .catch(() => null);
  }
}

module.exports = { EdgeHost, engineInitScript };
