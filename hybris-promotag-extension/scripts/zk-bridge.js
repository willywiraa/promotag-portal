/*
 * ZK bridge — runs in the page's MAIN world, the only place ZK's client engine (window.zk, zAu)
 * is reachable. The isolated content script talks to it through DOM CustomEvents whose
 * `detail` is a JSON string; target elements are handed over via a data-ptae-target attribute.
 *
 * It also observes ZK's AJAX ("AU") traffic without changing it: in-flight count, a response
 * counter (so the engine can wait for "the server answered after my action"), and errors
 * (network failure / session gone).
 */
(function () {
  'use strict';
  if (window.__PTAE_BRIDGE__) return;

  const REQ = 'ptae:bridge-req';
  const RES = 'ptae:bridge-res';
  const EVT = 'ptae:bridge-evt';
  const AU_URL = /\/zkau(?:[/?;#]|$)/;

  const state = { inflight: new Set(), auSeq: 0, lastAuError: null, lastResponseAt: 0 };

  function emit(type, data) {
    document.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify(Object.assign({ type }, data)) }));
  }

  function isAu(url) {
    try {
      return AU_URL.test(String(url));
    } catch (_) {
      return false;
    }
  }

  function trackStart() {
    const token = { startedAt: Date.now() };
    state.inflight.add(token);
    return token;
  }

  function trackEnd(token, status, finalUrl) {
    state.inflight.delete(token);
    state.auSeq++;
    state.lastResponseAt = Date.now();
    let kind = null;
    if (status === 0) kind = 'network';
    else if (status === 401 || status === 403 || status === 410) kind = 'session';
    else if (finalUrl && !isAu(finalUrl)) kind = 'session'; // AU request redirected to a login page
    else if (status >= 500) kind = 'server';
    if (kind) {
      state.lastAuError = { kind, status, at: Date.now() };
      emit('au-error', state.lastAuError);
    }
  }

  // --- Observe AU traffic (XHR + fetch) ---------------------------------------------------------
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open;
    const send = XHR.send;
    XHR.open = function (method, url) {
      this.__ptaeAu = isAu(url);
      return open.apply(this, arguments);
    };
    XHR.send = function () {
      if (this.__ptaeAu) {
        const token = trackStart();
        const xhr = this;
        xhr.addEventListener('loadend', () => trackEnd(token, xhr.status, xhr.responseURL), { once: true });
      }
      return send.apply(this, arguments);
    };
  }

  if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = input && typeof input === 'object' && 'url' in input ? input.url : input;
      if (!isAu(url)) return nativeFetch.apply(this, arguments);
      const token = trackStart();
      return nativeFetch.apply(this, arguments).then(
        (res) => {
          trackEnd(token, res.status, res.url);
          return res;
        },
        (err) => {
          trackEnd(token, 0, null);
          throw err;
        }
      );
    };
  }

  // --- ZK helpers --------------------------------------------------------------------------------
  function zkReady() {
    return !!(window.zk && window.zk.Widget && typeof window.zk.Widget.$ === 'function');
  }

  function zkVersion() {
    try {
      return (window.zk && window.zk.version) || null;
    } catch (_) {
      return null;
    }
  }

  function widgetFor(el) {
    if (!el || !zkReady()) return null;
    try {
      return window.zk.Widget.$(el) || null;
    } catch (_) {
      return null;
    }
  }

  function target(token) {
    if (!token) return null;
    return document.querySelector(`[data-ptae-target="${CSS.escape(String(token))}"]`);
  }

  function zkProcessing() {
    try {
      const au = window.zAu;
      return !!(au && typeof au.processing === 'function' && au.processing());
    } catch (_) {
      return false;
    }
  }

  function maskVisible() {
    const els = document.querySelectorAll('.z-loading, .z-apply-loading-indicator, .z-apply-mask');
    for (const el of els) {
      if (el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') return true;
    }
    return false;
  }

  function status() {
    let oldest = 0;
    state.inflight.forEach((t) => {
      if (!oldest || t.startedAt < oldest) oldest = t.startedAt;
    });
    const pending = state.inflight.size;
    return {
      zk: zkReady(),
      version: zkVersion(),
      pending,
      oldestPendingMs: oldest ? Date.now() - oldest : 0,
      auSeq: state.auSeq,
      busy: pending > 0 || zkProcessing() || maskVisible(),
      lastAuError: state.lastAuError,
    };
  }

  const ops = {
    ping: () => ({ zk: zkReady(), version: zkVersion() }),

    status,

    /** setValue + onChanging/onChange through the widget, so the server-side model is updated. */
    setValue(args) {
      const el = target(args.token);
      if (!el) throw new Error('target element not found');
      const w = widgetFor(el);
      if (!w) return { widget: false };
      const value = String(args.value);
      if (typeof w.setValue === 'function') w.setValue(value);
      const input = typeof w.getInputNode === 'function' ? w.getInputNode() || el : el;
      if (input.value !== value) input.value = value;
      const data = { value, start: value.length };
      if (args.changing && typeof w.fire === 'function') w.fire('onChanging', data, { toServer: true });
      if (args.change !== false) {
        if (typeof w.fireOnChange === 'function') w.fireOnChange({ toServer: true });
        else if (typeof w.fire === 'function') w.fire('onChange', data, { toServer: true });
      }
      return { widget: true, widgetName: w.widgetName || w.className || '', value: input.value };
    },

    /**
     * Opens the tree folder (Treeitem) that holds the target element, as its expander would: the
     * client opens it and sends onOpen, and the server renders the children.
     */
    openTreeItem(args) {
      let item = null;
      for (let x = widgetFor(target(args.token)); x && !item; x = x.parent) {
        if (x.widgetName === 'tree') break;
        if (x.widgetName === 'treeitem') item = x;
      }
      if (!item || typeof item.setOpen !== 'function') return { widget: false };
      const wasOpen = typeof item.isOpen === 'function' ? !!item.isOpen() : !!item._open;
      if (!wasOpen) item.setOpen(true);
      return { widget: true, wasOpen };
    },

    /** Fires onOK on the nearest widget that listens for it (Enter-key equivalent). */
    fireOk(args) {
      const w = widgetFor(target(args.token));
      for (let x = w; x; x = x.parent) {
        if (typeof x.isListen === 'function' && x.isListen('onOK')) {
          x.fire('onOK', null, { toServer: true });
          return { fired: true, widgetName: x.widgetName || '' };
        }
      }
      return { fired: false };
    },
  };

  document.addEventListener(REQ, (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.id !== 'string' || !Object.prototype.hasOwnProperty.call(ops, msg.op)) return;
    let res;
    try {
      res = { id: msg.id, ok: true, result: ops[msg.op](msg.args || {}) };
    } catch (err) {
      res = { id: msg.id, ok: false, error: String((err && err.message) || err) };
    }
    document.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(res) }));
  });

  window.__PTAE_BRIDGE__ = { version: 1 };
})();
