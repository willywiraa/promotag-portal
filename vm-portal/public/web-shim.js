/*
 * Lets the extension's own popup.js and history.js run as web pages served by the VM portal:
 *  - chrome.runtime.sendMessage   -> POST api/ui (the server runs the extension's background.js);
 *  - chrome.storage.onChanged     <- api/events (server-sent events), or polling when a proxy holds
 *                                    the stream back;
 *  - chrome.storage.session draft -> this browser's localStorage;
 *  - the history database         -> api/history and api/shots;
 *  - "Open in Promo Tag Portal"   -> tags read from this page's own URL (…/#promotags=…).
 * All URLs are relative, so the portal also works behind IIS at a sub-path such as /promotag/.
 * Load after the page's shared scripts and before popup.js / history.js.
 */
(function () {
  'use strict';
  const P = (window.PTAE = window.PTAE || {});
  const IMPORT_KEY = 'ptae-import';
  const DRAFT_KEY = 'ptae-draft';
  const IMPORT_TTL_MS = 3600000;
  const listeners = [];
  const version = (document.querySelector('meta[name="ptae-version"]') || {}).content || '';

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      return await res.json();
    } catch (_) {
      return { ok: false, error: `The portal answered HTTP ${res.status}.` };
    }
  }

  // --- live updates ------------------------------------------------------------------------------
  const POLL_AFTER_MS = 5000;
  const POLL_EVERY_MS = 3000;
  let stream = null;
  let streaming = false; // a ping or message arrived: the stream gets through
  let poller = null;
  let lastState = '';

  function emit(changes, area) {
    listeners.forEach((fn) => {
      try {
        fn(changes, area);
      } catch (err) {
        console.error(err);
      }
    });
  }

  /** Reports the run state as changes, like the stream would, when it differs from the last report. */
  async function catchUp() {
    const s = await post('api/ui', { type: 'UI_STATE' });
    if (!s || !s.ok) return;
    const last = s.logs.length ? s.logs[s.logs.length - 1].t : 0;
    const key = JSON.stringify([s.job, s.batch, s.logs.length, last]);
    if (key === lastState) return;
    lastState = key;
    emit({ job: { newValue: s.job }, batch: { newValue: s.batch }, logs: { newValue: s.logs } }, 'session');
  }

  function stopPolling() {
    clearInterval(poller);
    poller = null;
  }

  function connect() {
    if (stream) return;
    let opened = false;
    const heard = () => {
      streaming = true;
      stopPolling();
    };
    stream = new EventSource('api/events');
    stream.addEventListener('ping', heard);
    stream.onmessage = (e) => {
      heard();
      const m = JSON.parse(e.data);
      emit(m.changes, m.area);
    };
    stream.onopen = () => {
      if (!opened) {
        opened = true;
        return;
      }
      catchUp(); // reconnected: catch up on what changed while the connection was down
    };
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) disconnect(); // e.g. logged out: reconnect after the next login
    };
    // A proxy that holds the stream back delivers nothing: ask for the state every few seconds instead.
    setTimeout(() => {
      if (stream && !streaming && !poller) poller = setInterval(catchUp, POLL_EVERY_MS);
    }, POLL_AFTER_MS);
  }

  function disconnect() {
    if (stream) stream.close();
    stream = null;
    streaming = false;
    stopPolling();
  }

  // --- "Open in Promo Tag Portal" link -----------------------------------------------------------
  function readLink() {
    if (!P.teams || !P.parser) return;
    const link = P.teams.parseImportLink(location.href);
    if (!link) return;
    const parsed = P.parser.parseAlerts(link.text);
    const pending = { items: parsed.items, errors: parsed.errors, warnings: parsed.warnings, at: Date.now() };
    sessionStorage.setItem(IMPORT_KEY, JSON.stringify(pending));
    history.replaceState(null, '', location.pathname + location.search); // a reload must not import again
  }

  function pendingImport() {
    try {
      const p = JSON.parse(sessionStorage.getItem(IMPORT_KEY) || 'null');
      return p && Date.now() - p.at < IMPORT_TTL_MS ? p : null;
    } catch (_) {
      return null;
    }
  }

  // --- messages ----------------------------------------------------------------------------------
  async function sendMessage(msg) {
    if (msg.type === 'UI_OPEN_HISTORY') {
      window.open(`history${msg.runId ? `#run=${encodeURIComponent(msg.runId)}` : ''}`, '_blank');
      return { ok: true };
    }
    if (msg.type === 'UI_IMPORT_TAKE') {
      const pending = pendingImport();
      sessionStorage.removeItem(IMPORT_KEY);
      return { ok: true, import: pending };
    }
    const resp = await post('api/ui', msg);
    if (msg.type === 'UI_STATE' && resp.ok) resp.pendingImport = pendingImport();
    if ((msg.type === 'UI_STATE' && resp.ok && resp.auth.loggedIn) || (/^UI_(LOGIN|SETUP)$/.test(msg.type) && resp.ok)) connect();
    if (msg.type === 'UI_LOGOUT' || resp.code === 'AUTH') disconnect();
    return resp;
  }

  /** The History page checks the portal login through chrome.storage.local "portalSession". */
  async function visitorSession() {
    const s = await post('api/ui', { type: 'UI_STATE' });
    if (!s || !s.ok || !s.auth.loggedIn) return null;
    connect();
    return { token: 'portal-session-held-in-a-cookie', userId: s.auth.userId, expiresAt: s.auth.expiresAt };
  }

  function readDraft() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  window.chrome = Object.assign(window.chrome || {}, {
    runtime: {
      id: 'ptae-vm',
      lastError: undefined,
      getManifest: () => ({ version }),
      reload: () => location.reload(),
      sendMessage(msg, cb) {
        sendMessage(msg).then(
          (resp) => cb && cb(resp),
          (err) => cb && cb({ ok: false, error: `Portal not reachable (${err.message}).` })
        );
      },
    },
    storage: {
      local: {
        async get(key) {
          return [].concat(key).includes('portalSession') ? { portalSession: await visitorSession() } : {};
        },
        set: async () => {},
        remove: async () => {},
      },
      session: {
        get: async (key) => ([].concat(key).includes('draft') ? { draft: readDraft() } : {}),
        async set(items) {
          if ('draft' in items) localStorage.setItem(DRAFT_KEY, JSON.stringify(items.draft));
        },
        remove: async () => {},
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    permissions: { request: async () => true, contains: async () => true },
  });

  // --- History page: the database lives on the VM --------------------------------------------------
  if (P.historyDb) {
    const call = async (method, ...args) => {
      const r = await post('api/history', { method, args });
      if (!r.ok) throw new Error(r.error || 'History not available.');
      return r.result;
    };
    let bytes = 0;
    P.historyDb = Object.assign({}, P.historyDb, {
      listRuns: (opts) => call('listRuns', opts || {}),
      getRun: (id) => call('getRun', id),
      getLogs: (id) => call('getLogs', id),
      deleteRun: (id) => call('deleteRun', id),
      deleteRunsBefore: (ts) => call('deleteRunsBefore', ts),
      async counts() {
        const c = await call('counts');
        bytes = c.bytes || 0;
        return c;
      },
      async getScreenshotsForRun(id) {
        const shots = await call('getScreenshotsForRun', id);
        return Promise.all(shots.map(async (s) => {
          const res = await fetch(`api/shots/${encodeURIComponent(s.id)}`, { credentials: 'same-origin' });
          return Object.assign(s, { blob: await res.blob() });
        }));
      },
    });
    // "N MB used" means the VM's screenshots here, not this browser's storage.
    if (window.StorageManager) StorageManager.prototype.estimate = async () => ({ usage: bytes, quota: 0 });
  }

  readLink();
})();
