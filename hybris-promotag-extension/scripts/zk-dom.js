/*
 * DOM + ZK interaction helpers for the content script (isolated world) and the tests.
 * No chrome.* APIs in here. ZK widget calls go through the MAIN-world bridge (zk-bridge.js).
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});

  // --- Text ----------------------------------------------------------------------------------------
  const SPACE_LIKE = /[   -   　]/g;

  function normText(s) {
    return String(s == null ? '' : s).replace(/[​-‍﻿]/g, '').replace(SPACE_LIKE, ' ').replace(/\s+/g, ' ').trim();
  }
  function textOf(el) {
    return el ? normText(el.textContent) : '';
  }
  function eqi(a, b) {
    return normText(a).toLowerCase() === normText(b).toLowerCase();
  }
  /** Label text without trailing ":" / "*" (mandatory markers). */
  function labelText(s) {
    return normText(s).replace(/[\s:*]+$/, '').trim();
  }

  // --- Element queries -----------------------------------------------------------------------------
  function isVisible(el) {
    if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function qsa(selector, rootNode) {
    try {
      return Array.from((rootNode || document).querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function matchesText(actual, m) {
    if (!m) return true;
    const a = normText(actual).toLowerCase();
    if (m.equals != null) return a === normText(m.equals).toLowerCase();
    if (m.includes != null) return a.includes(normText(m.includes).toLowerCase());
    if (m.anyOf) return m.anyOf.some((x) => a === normText(x).toLowerCase());
    if (m.regex) return m.regex.test(normText(actual));
    return true;
  }

  function isExcluded(el, exclude) {
    return !!(exclude && exclude.some((x) => x && (x === el || (x.contains && x.contains(el)))));
  }

  /** querySelectorAll + visibility + exclusions + text matching (the ":contains()" the PRD asked for). */
  function findAll(selector, opts = {}) {
    const { root: r, text, visibleOnly = true, exclude } = opts;
    return qsa(selector, r).filter(
      (el) => (!visibleOnly || isVisible(el)) && !isExcluded(el, exclude) && matchesText(el.textContent, text)
    );
  }
  function findFirst(selector, opts) {
    return findAll(selector, opts)[0] || null;
  }

  function follows(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  /** Elements whose own text node reads exactly like one of `labels` (case-insensitive). */
  function findLabelElements(labels, opts = {}) {
    const wanted = labels.map((l) => labelText(l).toLowerCase());
    const rootNode = opts.root || document.body;
    const out = [];
    if (!rootNode) return out;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = labelText(n.nodeValue).toLowerCase();
      if (!t || !wanted.includes(t)) continue;
      const el = n.parentElement;
      if (!el || el.closest('script, style, option, textarea')) continue;
      if (isExcluded(el, opts.exclude)) continue;
      if (opts.visibleOnly !== false && !isVisible(el)) continue;
      if (!out.includes(el)) out.push(el);
    }
    return out;
  }

  /** True when a text node reading like one of `stopLabels` sits between `labelEl` and `input`. */
  function hasLabelBetween(labelEl, input, container, stopLabels) {
    if (!stopLabels || !stopLabels.length) return false;
    const stops = stopLabels.map((l) => labelText(l).toLowerCase());
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (labelEl.contains(n)) continue;
      if (!follows(labelEl, n) || !follows(n, input)) continue;
      if (stops.includes(labelText(n.nodeValue).toLowerCase())) return true;
    }
    return false;
  }

  const TEXT_INPUTS = 'input.z-textbox, input.ye-input-text, textarea.z-textbox';

  /**
   * Nearest input that follows `labelEl` inside the smallest enclosing container (≤ maxDepth levels).
   * Gives up when that container holds more than `maxInputs` fields or another known label sits in between,
   * so a label without its own input never borrows the next field's input.
   */
  function inputForLabel(labelEl, opts = {}) {
    const { inputSelector = TEXT_INPUTS, maxDepth = 6, maxInputs = 3, exclude, stopLabels } = opts;
    let node = labelEl.parentElement;
    for (let depth = 0; node && depth < maxDepth; depth++, node = node.parentElement) {
      const inputs = qsa(inputSelector, node).filter((i) => isVisible(i) && !isExcluded(i, exclude) && follows(labelEl, i));
      if (!inputs.length) continue;
      if (inputs.length > maxInputs) return null;
      if (hasLabelBetween(labelEl, inputs[0], node, stopLabels)) return null;
      return { input: inputs[0], label: labelEl, container: node };
    }
    return null;
  }

  function findInputByLabel(labels, opts = {}) {
    for (const labelEl of findLabelElements(labels, opts)) {
      const hit = inputForLabel(labelEl, opts);
      if (hit) return hit;
    }
    return null;
  }

  /** Text shown next to a label when the value is not an input (e.g. a read-only code). */
  function textAfterLabel(labelEl, maxDepth = 3) {
    const own = textOf(labelEl);
    let node = labelEl.parentElement;
    for (let depth = 0; node && depth < maxDepth; depth++, node = node.parentElement) {
      const all = textOf(node);
      if (all.length > own.length && all.length < 200) {
        const rest = normText(all.replace(own, '')).replace(/^[:*\s]+/, '');
        if (rest) return rest;
      }
    }
    return '';
  }

  function isTextInput(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.getAttribute('type') || 'text');
  }

  function isEditable(el) {
    return (
      isTextInput(el) &&
      !el.disabled &&
      !el.readOnly &&
      el.getAttribute('aria-readonly') !== 'true' &&
      el.getAttribute('aria-disabled') !== 'true'
    );
  }

  function isDisabled(el) {
    const cls = el.classList;
    return !!(
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true' ||
      (cls && (cls.contains('z-button-disabled') || cls.contains('z-disabled') || cls.contains('disabled')))
    );
  }

  function valueOf(el) {
    if (!el) return '';
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : textOf(el);
  }

  // --- Mouse / keyboard ----------------------------------------------------------------------------
  function ensureInView(el) {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch (_) { /* detached */ }
    }
  }

  function fireMouse(el, type, extra) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const init = Object.assign(
      { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 },
      extra
    );
    let ev;
    if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
      ev = new PointerEvent(type, Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } else {
      ev = new MouseEvent(type, init);
    }
    return el.dispatchEvent(ev);
  }

  function simulateClick(el, opts = {}) {
    const detail = opts.detail || 1;
    ensureInView(el);
    fireMouse(el, 'pointerover', { buttons: 0 });
    fireMouse(el, 'mouseover', { buttons: 0 });
    fireMouse(el, 'pointerdown', { buttons: 1 });
    fireMouse(el, 'mousedown', { buttons: 1, detail });
    if (el.matches && el.matches('input, textarea, button, a[href], [tabindex]')) {
      try {
        el.focus({ preventScroll: true });
      } catch (_) { /* not focusable */ }
    }
    fireMouse(el, 'pointerup', { buttons: 0 });
    fireMouse(el, 'mouseup', { buttons: 0, detail });
    fireMouse(el, 'click', { buttons: 0, detail });
  }

  function simulateDblClick(el) {
    simulateClick(el, { detail: 1 });
    simulateClick(el, { detail: 2 });
    fireMouse(el, 'dblclick', { buttons: 0, detail: 2 });
  }

  const KEYS = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    s: { key: 's', code: 'KeyS', keyCode: 83 },
  };

  function pressKey(el, name, mods = {}) {
    const k = KEYS[name] || { key: name, code: name, keyCode: 0 };
    const init = Object.assign(
      { bubbles: true, cancelable: true, composed: true, view: window, key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode },
      mods
    );
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (k.key === 'Enter' || k.key.length === 1) {
      const charCode = k.key === 'Enter' ? 13 : k.key.charCodeAt(0);
      el.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, init, { charCode })));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  // --- Waiting -------------------------------------------------------------------------------------
  class TimeoutError extends Error {
    constructor(label, ms) {
      super(`Timed out after ${ms} ms waiting for ${label}`);
      this.name = 'TimeoutError';
      this.label = label;
      this.ms = ms;
    }
  }

  class AbortError extends Error {
    constructor(reason) {
      super(String((reason && reason.message) || reason || 'Aborted'));
      this.name = 'AbortError';
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new AbortError(signal.reason));
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError(signal.reason));
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Polls `probe` with exponential backoff (PRD: 300 ms start, 8000 ms default budget). */
  async function waitFor(probe, opts = {}) {
    const { timeout = 8000, interval = 300, factor = 1.5, maxInterval = 2400, signal, label = 'condition' } = opts;
    const start = Date.now();
    let delay = interval;
    for (;;) {
      if (signal && signal.aborted) throw new AbortError(signal.reason);
      const v = await probe();
      if (v) return v;
      const elapsed = Date.now() - start;
      if (elapsed >= timeout) throw new TimeoutError(label, timeout);
      await sleep(Math.min(delay, timeout - elapsed), signal);
      delay = Math.min(Math.round(delay * factor), maxInterval);
    }
  }

  /** Resolves true once `target` has had no DOM mutations for `quietMs` (false if `timeout` hits first). */
  function waitDomStable(target, quietMs = 500, timeout = 5000, signal) {
    return new Promise((resolve, reject) => {
      const node = target || document.body;
      let quiet = setTimeout(() => finish(true), quietMs);
      const hard = setTimeout(() => finish(false), timeout);
      const obs = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(true), quietMs);
      });
      const onAbort = () => {
        cleanup();
        reject(new AbortError(signal.reason));
      };
      function cleanup() {
        obs.disconnect();
        clearTimeout(quiet);
        clearTimeout(hard);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function finish(stable) {
        cleanup();
        resolve(stable);
      }
      obs.observe(node, { childList: true, subtree: true, characterData: true });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // --- Evidence highlight --------------------------------------------------------------------------
  const COLORS = { green: '#16A34A', amber: '#F59E0B', red: '#DC2626', blue: '#0066FF' };

  /** Temporarily outlines an element (rows get their cells tinted too). Returns a restore function. */
  function highlight(el, color = 'green') {
    if (!el || !el.style) return () => {};
    const c = COLORS[color] || color;
    const touched = [];
    const paint = (node, styles) => {
      const prev = {};
      Object.keys(styles).forEach((k) => {
        prev[k] = node.style[k];
        node.style[k] = styles[k];
      });
      touched.push([node, prev]);
    };
    paint(el, { outline: `3px solid ${c}`, outlineOffset: '-2px' });
    if (el.tagName === 'TR') Array.from(el.cells || []).forEach((td) => paint(td, { backgroundColor: `${c}22` }));
    else paint(el, { boxShadow: `0 0 0 4px ${c}40` });
    return () => touched.reverse().forEach(([node, prev]) => Object.keys(prev).forEach((k) => { node.style[k] = prev[k]; }));
  }

  // --- MAIN-world bridge client --------------------------------------------------------------------
  let tokenSeq = 0;
  function markTarget(el) {
    const token = `t${Date.now().toString(36)}${++tokenSeq}`;
    el.setAttribute('data-ptae-target', token);
    return token;
  }
  function unmarkTarget(el) {
    if (el) el.removeAttribute('data-ptae-target');
  }

  function createBridgeClient(opts = {}) {
    const timeout = opts.timeout || 4000;
    const pending = new Map();
    const listeners = new Set();
    let seq = 0;
    let available = false;

    const onRes = (e) => {
      let m;
      try {
        m = JSON.parse(e.detail);
      } catch (_) {
        return;
      }
      const p = m && pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || 'ZK bridge error'));
    };
    const onEvt = (e) => {
      let m;
      try {
        m = JSON.parse(e.detail);
      } catch (_) {
        return;
      }
      listeners.forEach((fn) => {
        try {
          fn(m);
        } catch (_) { /* listener error */ }
      });
    };
    document.addEventListener('ptae:bridge-res', onRes);
    document.addEventListener('ptae:bridge-evt', onEvt);

    function call(op, args, ms) {
      return new Promise((resolve, reject) => {
        const id = `r${++seq}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ZK bridge did not answer "${op}"`));
        }, ms || timeout);
        pending.set(id, { resolve, reject, timer });
        document.dispatchEvent(new CustomEvent('ptae:bridge-req', { detail: JSON.stringify({ id, op, args: args || {} }) }));
      });
    }

    async function ready() {
      if (available) return true;
      for (let i = 0; i < 5; i++) {
        try {
          await call('ping', {}, 500);
          available = true;
          return true;
        } catch (_) {
          await sleep(200);
        }
      }
      return false;
    }

    return {
      call,
      ready,
      onEvent(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      dispose() {
        document.removeEventListener('ptae:bridge-res', onRes);
        document.removeEventListener('ptae:bridge-evt', onEvt);
        pending.forEach((p) => clearTimeout(p.timer));
        pending.clear();
        listeners.clear();
      },
    };
  }

  /**
   * Injects a value into a ZK textbox and syncs it to the server-side widget model (PRD §5 helper).
   * Adapted from the PRD: async; the ZK widget step runs in the MAIN world via the bridge (window.zk
   * is invisible to content scripts); Enter is opt-in and sent after onChange so the server already
   * holds the new value when onOK fires.
   * @param {HTMLElement} element  target input
   * @param {string} value
   * @param {{bridge?: object, enter?: boolean, changing?: boolean}} opts
   * @returns {Promise<{ok: boolean, synced: boolean}>}
   */
  async function setZkInputValue(element, value, opts = {}) {
    if (!element) return { ok: false, synced: false };
    const { bridge, enter = false, changing = false } = opts;

    // 1. Focus
    try {
      element.focus({ preventScroll: true });
    } catch (_) { /* not focusable */ }

    // 2. Assign the value through the native setter
    setNativeValue(element, value);

    // 3. Standard DOM events (+ keyup so ZK's own change tracking sees the edit)
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'End', code: 'End', keyCode: 35 }));

    // 4. ZK widget sync (MAIN world): setValue + onChanging/onChange to the server
    let synced = false;
    if (bridge && (await bridge.ready())) {
      const token = markTarget(element);
      try {
        const r = await bridge.call('setValue', { token, value, changing, change: true });
        synced = !!(r && r.widget);
      } catch (_) {
        synced = false;
      } finally {
        unmarkTarget(element);
      }
    }

    // 5. Optional Enter (search/filter fields only)
    if (enter) pressKey(element, 'Enter');

    // 6. Blur
    try {
      element.blur();
    } catch (_) { /* detached */ }

    return { ok: element.value === value, synced };
  }

  // --- Diagnostics ---------------------------------------------------------------------------------
  function describeVisibleLabels(rootNode, max = 25) {
    const seen = [];
    const walker = document.createTreeWalker(rootNode || document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && seen.length < max; n = walker.nextNode()) {
      const t = labelText(n.nodeValue);
      const el = n.parentElement;
      if (!t || t.length > 40 || !el || el.closest('script, style')) continue;
      if (!/label|header|caption|title/i.test(el.className || '') && el.tagName !== 'LABEL' && el.tagName !== 'TH') continue;
      if (!isVisible(el) || seen.includes(t)) continue;
      seen.push(t);
    }
    return seen.join(' | ') || '(none)';
  }

  function describeVisibleButtons(rootNode, max = 20) {
    const out = [];
    for (const b of findAll('button, [role="button"]', { root: rootNode })) {
      const t = textOf(b) || b.getAttribute('title') || b.getAttribute('aria-label') || '';
      if (t && !out.includes(t)) out.push(t);
      if (out.length >= max) break;
    }
    return out.join(' | ') || '(none)';
  }

  PTAE.dom = {
    normText, textOf, eqi, labelText,
    isVisible, qsa, findAll, findFirst, matchesText, follows,
    findLabelElements, hasLabelBetween, inputForLabel, findInputByLabel, textAfterLabel,
    isTextInput, isEditable, isDisabled, valueOf,
    simulateClick, simulateDblClick, pressKey, setNativeValue, setZkInputValue,
    sleep, waitFor, waitDomStable, TimeoutError, AbortError,
    highlight, markTarget, unmarkTarget, createBridgeClient,
    describeVisibleLabels, describeVisibleButtons,
    TEXT_INPUTS,
  };
})(globalThis);
