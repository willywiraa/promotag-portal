/*
 * The chrome.* extension APIs that the extension's service worker (background.js) uses, implemented
 * in Node with Edge (lib/browser.js) as the browser, so the same background.js runs the portal on a VM:
 *  - storage.local is saved to a JSON file; storage.session lives in memory and reports its changes;
 *  - the portal login (storage key "portalSession") belongs to the web visitor: the server puts the
 *    visitor's session in an AsyncLocalStorage context for each request;
 *  - tabs are Edge pages, content scripts are installed by browser.js, alarms are timers,
 *    badges and the popup do nothing.
 */
'use strict';
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { EdgeHost } = require('./browser');

const EXTENSION_ID = 'ptae-vm';
const SESSION_KEY = 'portalSession';
const requestContext = new AsyncLocalStorage();

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function event() {
  const fns = new Set();
  return {
    addListener: (fn) => fns.add(fn),
    removeListener: (fn) => fns.delete(fn),
    hasListener: (fn) => fns.has(fn),
    /** Calls every listener; returns their results. Async listener failures are logged, not thrown. */
    emit(...args) {
      return [...fns].map((fn) => {
        try {
          const r = fn(...args);
          if (r && typeof r.catch === 'function') r.catch((err) => console.error('Listener failed:', err));
          return r;
        } catch (err) {
          console.error('Listener failed:', err);
          return undefined;
        }
      });
    },
  };
}

function keyList(keys, data) {
  if (keys == null) return Object.keys(data);
  if (typeof keys === 'string') return [keys];
  return Array.isArray(keys) ? keys : Object.keys(keys);
}

/** A chrome.storage area; `file` persists it (local), without a file it lives in memory (session). */
function storageArea(name, file, onChanged) {
  let data = {};
  if (file) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      /* first start */
    }
  }
  let writing = Promise.resolve();
  function persist() {
    if (!file) return writing;
    const json = JSON.stringify(data, null, 2);
    writing = writing.then(() => fs.promises.writeFile(file, json)).catch((err) => console.error(`Settings not saved: ${err.message}`));
    return writing;
  }
  // The login is per visitor, never stored: see the header comment.
  const visitorKey = (k) => name === 'local' && k === SESSION_KEY;

  return {
    async get(keys) {
      const out = {};
      for (const k of keyList(keys, data)) {
        if (visitorKey(k)) {
          const ctx = requestContext.getStore();
          if (ctx && ctx.session) out[k] = clone(ctx.session);
        } else if (k in data) {
          out[k] = clone(data[k]);
        }
      }
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        Object.entries(keys).forEach(([k, v]) => {
          if (!(k in out)) out[k] = v;
        });
      }
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items || {})) {
        if (visitorKey(k)) {
          const ctx = requestContext.getStore();
          if (ctx) Object.assign(ctx, { session: clone(v), sessionChanged: true });
          continue;
        }
        changes[k] = { newValue: clone(v) };
        data[k] = clone(v);
      }
      await persist();
      if (Object.keys(changes).length) onChanged(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (visitorKey(k)) {
          const ctx = requestContext.getStore();
          if (ctx) Object.assign(ctx, { session: null, sessionChanged: true });
        } else if (k in data) {
          changes[k] = { newValue: undefined };
          delete data[k];
        }
      }
      await persist();
      if (Object.keys(changes).length) onChanged(changes, name);
    },
    /** Synchronous read for the portal itself. */
    peek: (k) => clone(data[k]),
  };
}

/** "https://host/backoffice/*" -> RegExp */
function matchPattern(pattern) {
  return new RegExp(`^${String(pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

/**
 * opts: { settingsFile, edge: { extDir, profileDir, channel, headless, viewport } }
 * returns { chrome, host, dispatch(msg, sender) }
 */
function createChrome(opts) {
  const onChanged = event();
  const onMessage = event();
  const onAlarm = event();
  const tabEvents = { onCreated: event(), onUpdated: event(), onRemoved: event() };
  const registered = [];
  const timers = new Map();

  /** Delivers a message to background.js listeners, like chrome.runtime.sendMessage. */
  function dispatch(msg, sender) {
    return new Promise((resolve) => {
      let done = false;
      const reply = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      const results = onMessage.emit(msg, sender, reply);
      if (!done && !results.includes(true)) resolve(undefined);
    });
  }

  const installsOn = (url) => registered.some((s) => (s.matches || []).some((m) => matchPattern(m).test(url)));

  const host = new EdgeHost(
    Object.assign({}, opts.edge, {
      async onPageMessage(tabId, page, frame, msg) {
        if (tabId == null || !msg || typeof msg.type !== 'string') return null;
        if (msg.type === 'VM_PAGE') return { install: frame === page.mainFrame() && installsOn(frame.url()) };
        if (!msg.type.startsWith('CS_')) return null;
        return dispatch(msg, { id: EXTENSION_ID, url: frame.url(), frameId: 0, tab: host.info(tabId) });
      },
      onTabCreated: (id, url) => tabEvents.onCreated.emit(Object.assign({ pendingUrl: url }, host.info(id))),
      onTabUpdated: (id, url) => tabEvents.onUpdated.emit(id, { status: 'loading', url }, host.info(id)),
      onTabRemoved: (id) => tabEvents.onRemoved.emit(id, { windowId: 1, isWindowClosing: false }),
    })
  );

  const noop = async () => {};
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined,
      getURL: (p) => `chrome-extension://${EXTENSION_ID}/${String(p || '').replace(/^\//, '')}`,
      onMessage,
      onInstalled: event(),
      onStartup: event(),
    },
    storage: {
      local: storageArea('local', opts.settingsFile, (c, a) => onChanged.emit(c, a)),
      session: storageArea('session', null, (c, a) => onChanged.emit(c, a)),
      onChanged,
    },
    tabs: {
      query: async (q = {}) => host.list().filter((t) => q.active == null || t.active === q.active),
      async get(id) {
        const t = host.info(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return t;
      },
      create: ({ url, active } = {}) => host.create(url, active),
      update: (id, props) => host.update(id, props),
      sendMessage: (id, msg) => host.command(id, msg),
      captureVisibleTab: () => host.screenshotActive(),
      onCreated: tabEvents.onCreated,
      onUpdated: tabEvents.onUpdated,
      onRemoved: tabEvents.onRemoved,
    },
    windows: {
      get: async (id) => ({ id, state: 'normal', focused: true }),
      update: async (id) => ({ id, state: 'normal', focused: true }),
    },
    scripting: {
      getRegisteredContentScripts: async () => clone(registered),
      async unregisterContentScripts({ ids } = {}) {
        for (let i = registered.length - 1; i >= 0; i--) if (!ids || ids.includes(registered[i].id)) registered.splice(i, 1);
      },
      async registerContentScripts(list) {
        registered.push(...clone(list));
      },
      async executeScript({ target }) {
        return [{ result: await host.install(target.tabId) }];
      },
    },
    alarms: {
      async create(name, info = {}) {
        clearInterval(timers.get(name));
        const minutes = info.periodInMinutes || info.delayInMinutes || 1;
        timers.set(name, setInterval(() => onAlarm.emit({ name }), Math.max(3000, minutes * 60000)));
      },
      async clear(name) {
        const had = timers.has(name);
        clearInterval(timers.get(name));
        timers.delete(name);
        return had;
      },
      onAlarm,
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, openPopup: noop },
    permissions: { contains: async () => true, request: async () => true, onAdded: event(), onRemoved: event() },
  };

  return { chrome, host, dispatch };
}

/**
 * background.js checks that Backoffice is reachable before a run. Answer through Edge (its proxy,
 * certificates and VPN) instead of Node; other requests (the Teams workflow) use Node's fetch.
 */
function routeBackofficeFetch(host, storage) {
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String((input && input.url) || input);
    let origin = null;
    try {
      origin = new URL((storage.peek('settings') || {}).baseUrl).origin;
    } catch (_) {
      /* not configured */
    }
    if (!origin || !url.startsWith(`${origin}/`)) return nodeFetch(input, init);
    const ok = await host.canReach(url, 8000);
    if (ok === true) return new Response(null, { status: 200 });
    if (ok === false) throw new TypeError('fetch failed');
    const { cache, credentials, mode, ...rest } = init; // browser-only options
    return nodeFetch(input, rest);
  };
}

module.exports = { createChrome, routeBackofficeFetch, requestContext, EXTENSION_ID };
