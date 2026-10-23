/*
 * Promotion Tag amendment engine (content script, isolated world).
 * auth → navigation → search → review (read old value) → confirm → amend → save →
 * verify by searching again (with retries) → evidence screenshots.
 *
 * The runner only talks to the outside world through `transport.send(type, payload)`, so the
 * tests can drive it against a mock Backoffice. The chrome bootstrap at the bottom only runs
 * inside the extension.
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});
  const D = PTAE.dom;

  const MSG = {
    NETWORK: 'Network Error: Verify GlobalProtect VPN connection.',
    SESSION: 'Hybris session expired. Re-authenticate via SSO.',
    notFound: (code) => `Tag Code ${code} not found in Hybris.`,
  };

  class PtaeError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PtaeError';
      this.code = code;
    }
  }

  class NavigationPending extends Error {
    constructor() {
      super('Page is navigating');
      this.name = 'NavigationPending';
    }
  }

  function createRunner(deps) {
    const transport = deps.transport;
    const bridge = deps.bridge || null;
    const cfg = deps.config || PTAE.CONFIG;
    const rowCells = PTAE.sel.rowCells;
    let active = null; // { jobId, controller, confirm, timer }
    let fatal = null; // set asynchronously by bridge events (e.g. session gone)

    if (bridge && bridge.onEvent) {
      bridge.onEvent((e) => {
        if (e && e.type === 'au-error' && e.kind === 'session' && active) fatal = new PtaeError('SESSION', MSG.SESSION);
      });
    }

    // --- plumbing ----------------------------------------------------------------------------------
    function send(type, payload) {
      const body = Object.assign({ jobId: active && active.jobId }, payload);
      return Promise.resolve()
        .then(() => transport.send(type, body))
        .catch(() => undefined);
    }

    const log = (level, msg) => send('CS_LOG', { level, msg });

    function checkFatal(signal) {
      if (signal && signal.aborted) throw new D.AbortError(signal.reason);
      if (fatal) throw fatal;
    }

    function waitOpts(signal, label, timeout) {
      return Object.assign({}, cfg.poll, { signal, label, timeout: timeout || cfg.budgets.default });
    }

    function find(key, ctx, opts) {
      return PTAE.resolve(key, ctx, opts);
    }

    function waitFind(key, ctx, signal, timeout) {
      return D.waitFor(() => {
        checkFatal(signal);
        return find(key, ctx);
      }, waitOpts(signal, PTAE.SELECTORS[key].description, timeout));
    }

    function found(hit, label) {
      const what = label || PTAE.SELECTORS[hit.key].description;
      return log(hit.tier === 'fallback' ? 'warn' : 'info', `${what} found (${hit.tier}: ${hit.strategy})`);
    }

    async function bridgeStatus() {
      if (!bridge) return null;
      try {
        return await bridge.call('status', {}, 1500);
      } catch (_) {
        return null;
      }
    }

    async function auSeq() {
      const st = await bridgeStatus();
      return st ? st.auSeq : null;
    }

    function domBusy() {
      return !!D.findFirst('.z-loading, .z-apply-loading-indicator, .z-apply-mask');
    }

    /** Waits until ZK has no AU request in flight for `stableMs`. */
    async function waitIdle(signal, opts = {}) {
      const stableMs = opts.stableMs || 400;
      const timeout = opts.timeout || cfg.budgets.idle;
      const start = Date.now();
      let quietSince = null;
      for (;;) {
        checkFatal(signal);
        const st = await bridgeStatus();
        const busy = st ? st.busy : domBusy();
        const now = Date.now();
        if (!busy) {
          if (quietSince === null) quietSince = now;
          if (now - quietSince >= stableMs) return true;
        } else {
          quietSince = null;
        }
        if (now - start > timeout) {
          if (st && st.pending > 0 && st.oldestPendingMs > cfg.auStallMs) throw new PtaeError('NETWORK', MSG.NETWORK);
          return false;
        }
        await D.sleep(100, signal);
      }
    }

    /** Waits until ZK has processed at least one AU response after `seq` (false if none came). */
    async function waitAuAfter(seq, signal, timeout = 3000) {
      if (seq == null) {
        await D.sleep(150, signal);
        return false;
      }
      try {
        await D.waitFor(async () => {
          checkFatal(signal);
          const st = await bridgeStatus();
          return !!st && st.auSeq > seq;
        }, { timeout, interval: 100, factor: 1.3, maxInterval: 400, signal, label: 'server response' });
        return true;
      } catch (err) {
        if (err instanceof D.TimeoutError) return false;
        throw err;
      }
    }

    function blockingDialog() {
      const dlg = D.findAll('.z-messagebox-window, .z-window-modal, .z-window-highlighted')
        .find((w) => !w.querySelector('tr.yw-selector-listitem'));
      return dlg ? D.textOf(dlg).slice(0, 160) : null;
    }

    async function diagnose(err) {
      if (err instanceof PtaeError) return err;
      if (fatal) return fatal;
      const st = await bridgeStatus();
      const recent = st && st.lastAuError && Date.now() - st.lastAuError.at < 60000 ? st.lastAuError : null;
      if (!navigator.onLine || (recent && recent.kind === 'network') || (st && st.pending > 0 && st.oldestPendingMs > cfg.auStallMs)) {
        return new PtaeError('NETWORK', MSG.NETWORK);
      }
      if ((recent && recent.kind === 'session') || find('ssoLink', {})) return new PtaeError('SESSION', MSG.SESSION);
      const dlg = blockingDialog();
      if (dlg) return new PtaeError('DIALOG', `A Backoffice dialog is blocking the run: "${dlg}". Close it and retry.`);
      if (err instanceof D.TimeoutError) {
        return new PtaeError('TIMEOUT', `${err.message}. Visible labels: ${D.describeVisibleLabels(document.body)}`);
      }
      return new PtaeError('ERROR', String((err && err.message) || err));
    }

    function isSelectedRow(tr) {
      return !!tr && (tr.classList.contains('z-listitem-selected') || tr.getAttribute('aria-selected') === 'true');
    }

    function isTreeSelected(el) {
      const tr = el && el.closest('tr, [role="treeitem"]');
      return !!tr && (tr.classList.contains('z-treerow-selected') || tr.getAttribute('aria-selected') === 'true');
    }

    function firstLabelCell(tr) {
      const label = tr && tr.querySelector('.yw-listview-cell-label');
      if (label) return label;
      return (tr && tr.cells && tr.cells[0]) || tr;
    }

    function waitForUnload(ms) {
      return new Promise((resolve) => {
        const onHide = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          window.removeEventListener('pagehide', onHide);
          resolve(false);
        }, ms);
        window.addEventListener('pagehide', onHide, { once: true });
      });
    }

    // --- Stage 1: authentication & role ------------------------------------------------------------
    function detectState(ctx) {
      let hit;
      if ((hit = find('ssoLink', ctx))) return { name: 'SSO', hit };
      if ((hit = find('roleRow', ctx))) return { name: 'ROLE', hit };
      if ((hit = find('treeFilter', ctx) || find('searchModeToggle', ctx) || find('promotionTagNode', ctx))) return { name: 'SHELL', hit };
      if ((hit = find('loginForm', ctx))) return { name: 'LOGIN_FORM', hit };
      return null;
    }

    async function stageAuth(job, ctx, signal) {
      for (let round = 0; round < 6; round++) {
        const state = await D.waitFor(() => {
          checkFatal(signal);
          return detectState(ctx);
        }, waitOpts(signal, 'Backoffice to load', cfg.budgets.shell));

        if (state.name === 'SHELL') {
          if (!job.reachedShell) {
            job.reachedShell = true;
            await send('CS_STAGE', { stage: 'SHELL', data: { reachedShell: true } });
          }
          return;
        }

        if (state.name === 'SSO') {
          const attempts = job.ssoAttempts || 0;
          if (job.reachedShell) await log('warn', MSG.SESSION);
          if (attempts >= cfg.maxSsoAttempts) throw new PtaeError('SESSION', MSG.SESSION);
          await found(state.hit);
          // Persist before leaving the page: the next page load resumes from this stage.
          await send('CS_STAGE', { stage: 'AWAIT_SSO', data: { ssoAttempts: attempts + 1 } });
          await log('info', '[1/4] Signing in with Single Sign On…');
          const left = waitForUnload(10000);
          state.hit.el.click();
          if (!(await left)) {
            await log('warn', 'The SSO link did not navigate; opening the SSO address directly.');
            window.location.assign(state.hit.el.href);
          }
          throw new NavigationPending();
        }

        if (state.name === 'ROLE') {
          await stageRole(ctx, state.hit, signal);
          continue;
        }

        await log('warn', 'Backoffice login form shown — please sign in manually; waiting…');
        await D.waitFor(() => {
          checkFatal(signal);
          const s = detectState(ctx);
          return s && s.name !== 'LOGIN_FORM' ? s : null;
        }, waitOpts(signal, 'manual sign-in', cfg.budgets.manualLogin));
      }
      throw new PtaeError('ERROR', 'Could not reach the Backoffice workspace.');
    }

    async function stageRole(ctx, hit, signal) {
      await found(hit);
      const row = hit.el;
      if (!isSelectedRow(row)) {
        D.simulateClick(row.cells && row.cells[0] ? row.cells[0] : row);
        await D.waitFor(() => isSelectedRow(row) || !row.isConnected, waitOpts(signal, 'role selection', 3000)).catch((err) => {
          if (!(err instanceof D.TimeoutError)) throw err;
        });
      }
      await waitIdle(signal);
      if (!row.isConnected || !D.isVisible(row)) return; // selecting alone entered Backoffice

      await send('CS_STAGE', { stage: 'ROLE_SUBMIT', data: {} });
      const btn = find('roleConfirmButton', Object.assign({}, ctx, { roleRowEl: row }));
      if (btn) {
        await log('info', `[1/4] Role "${ctx.roleName}" selected — clicking "${D.textOf(btn.el) || btn.el.title}".`);
        D.simulateClick(btn.el);
      } else {
        await log('info', `[1/4] Role "${ctx.roleName}" selected — double-clicking to enter Backoffice.`);
        D.simulateDblClick(row.cells && row.cells[0] ? row.cells[0] : row);
      }
      await D.waitFor(() => {
        checkFatal(signal);
        return !row.isConnected || !D.isVisible(row) || !!find('treeFilter', ctx);
      }, waitOpts(signal, 'Backoffice after role selection', cfg.budgets.shell));
    }

    // --- Stage 2: navigation -----------------------------------------------------------------------
    const OPEN_ICON = /(caret|angle|chevron|arrow)-down|tree-open|icon-minus/i;
    const CLOSED_ICON = /(caret|angle|chevron|arrow)-right|tree-close|icon-plus/i;

    /** A tree row's expander and whether it is open (null when the markup doesn't tell). */
    function treeExpander(row) {
      const toggle = row.querySelector('.z-tree-icon, [id$="-open"]');
      const aria = row.getAttribute('aria-expanded');
      const classes = toggle ? [toggle, ...toggle.querySelectorAll('*')].map((e) => e.getAttribute('class') || '').join(' ') : '';
      const open = aria ? aria === 'true' : OPEN_ICON.test(classes) ? true : CLOSED_ICON.test(classes) ? false : null;
      return { toggle, open };
    }

    /** Notes when the explorer tree last changed: every filter pass and every opened folder re-renders it. */
    function watchTree() {
      const watch = { changedAt: Date.now() };
      const inTree = (n) =>
        !!n && n.nodeType === 1 && (n.matches('.z-tree, .z-treerow') || !!n.closest('.z-tree') || !!n.querySelector('.z-treerow'));
      const obs = new MutationObserver((records) => {
        if (records.some((r) => inTree(r.target) || [...r.addedNodes, ...r.removedNodes].some(inTree))) watch.changedAt = Date.now();
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-expanded'] });
      watch.stop = () => obs.disconnect();
      return watch;
    }

    /** Opens a folder through ZK, as its expander does: true if opened, false if already open, null without ZK. */
    async function openTreeItemViaZk(row) {
      if (!bridge || !(await bridge.ready())) return null;
      const token = D.markTarget(row);
      try {
        const r = await bridge.call('openTreeItem', { token });
        return r && r.widget ? !r.wasOpen : null;
      } catch (_) {
        return null;
      } finally {
        D.unmarkTarget(row);
      }
    }

    function clickTreeExpander(row) {
      const { toggle, open } = treeExpander(row);
      if (!toggle || open === true) return false;
      D.simulateClick(toggle);
      return true;
    }

    /**
     * Opens a closed tree folder; false if nothing was done. Retries alternate between ZK's API and the
     * expander, so one way that doesn't work on this Backoffice can't use up every try.
     */
    async function openTreeFolder(row, expanderFirst) {
      if (expanderFirst) return clickTreeExpander(row) || (await openTreeItemViaZk(row)) === true;
      const viaZk = await openTreeItemViaZk(row);
      return viaZk === null ? clickTreeExpander(row) : viaZk;
    }

    /** Opens the outermost closed folder above Promotion Tag; returns its label, or null. */
    async function openParentFolder(tries) {
      for (const label of cfg.promotionTagParents) {
        const el = D.findFirst('.z-tree span.z-label, .z-tree div.z-treecell-content', { text: { equals: label } });
        const row = el && el.closest('tr, [role="treeitem"]');
        const n = tries.get(label) || 0;
        if (!row || n >= cfg.treeOpenTries) continue;
        if (!(await openTreeFolder(row, n % 2 === 1))) continue;
        tries.set(label, n + 1);
        return label;
      }
      return null;
    }

    /**
     * Filters the explorer tree by Promotion Tag's own label, so Backoffice itself opens the folders
     * above it, and waits for the node. Nothing is decided while the tree is still changing: on a
     * fresh session Backoffice can filter more than once, and each pass rebuilds the tree. Other
     * traffic on the page (e.g. the Home dashboard refreshing) does not hold this up. A folder above
     * Promotion Tag that stays closed is opened, again if a later pass closes it.
     */
    async function revealPromotionTag(ctx, signal) {
      const filter = await waitFind('treeFilter', ctx, signal);
      await found(filter);
      const tree = watchTree();
      try {
        const typedAt = Date.now();
        await D.setZkInputValue(filter.el, cfg.treeFilterText, { bridge, changing: true, enter: true });
        const tries = new Map();
        return await D.waitFor(async () => {
          checkFatal(signal);
          const st = await bridgeStatus();
          const err = st && st.lastAuError;
          if (err && err.kind === 'network' && err.at >= typedAt) throw new PtaeError('NETWORK', MSG.NETWORK); // no point waiting
          const now = Date.now();
          if (now - Math.max(tree.changedAt, typedAt) < cfg.treeSettleMs) return null;
          const hit = find('promotionTagNode', ctx);
          if (hit) return hit;
          // Folders are opened only once the filter has been answered, which re-renders the tree (the
          // page's other requests don't tell): before that, the tree shown is not filtered yet. If the
          // tree never changes (e.g. the same filter text as before), go ahead after half the budget.
          if (tree.changedAt <= typedAt && now - typedAt < cfg.budgets.navigate / 2) return null;
          const opened = await openParentFolder(tries);
          if (opened) await log('info', `Opening "${opened}" in the tree…`);
          return null;
        }, waitOpts(signal, PTAE.SELECTORS.promotionTagNode.description, cfg.budgets.navigate));
      } finally {
        tree.stop();
      }
    }

    async function stageNavigate(ctx, signal) {
      await log('info', '[2/4] Opening Promotion Tag…');
      let node = find('promotionTagNode', ctx);
      if (node && isTreeSelected(node.el)) {
        await log('ok', 'Promotion Tag is already open.');
        return;
      }
      if (!node) node = await revealPromotionTag(ctx, signal);
      await found(node);
      for (let attempt = 1; ; attempt++) {
        D.simulateClick(node.el);
        try {
          await D.waitFor(() => {
            checkFatal(signal);
            const n = find('promotionTagNode', ctx);
            return n && isTreeSelected(n.el);
          }, waitOpts(signal, 'Promotion Tag to open'));
          break;
        } catch (err) {
          if (!(err instanceof D.TimeoutError)) throw err;
          if (find('searchModeToggle', ctx)) {
            await log('warn', 'Could not confirm the tree selection; continuing because the search panel is visible.');
            break;
          }
          // A re-render can replace the row under the click: click the node shown now, once.
          const again = attempt < 2 && find('promotionTagNode', ctx);
          if (!again) throw err;
          await log('warn', 'Promotion Tag did not open; clicking it again.');
          node = again;
        }
      }
      await waitIdle(signal);
    }

    // --- Stage 3: search & record selection --------------------------------------------------------
    function searchRowFor(input) {
      for (let n = input.parentElement, d = 0; n && d < 6; n = n.parentElement, d++) {
        if (D.findLabelElements(cfg.tagCodeLabels, { root: n }).length) return n;
      }
      return input.parentElement;
    }

    /** The whole advanced-search panel, so none of its fields is ever mistaken for the record editor. */
    function searchPanelFor(input, row) {
      const named = input.closest('[class*="advancedsearch" i], [class*="advanced-search" i]');
      if (named) return named;
      const btn = find('searchButton', { cfg, searchInput: input });
      if (btn) {
        let lca = input.parentElement;
        while (lca && !lca.contains(btn.el)) lca = lca.parentElement;
        const tooBig = !lca || lca.querySelector('tr.z-listitem') || PTAE.sel.editorRoots().some((r) => lca.contains(r));
        if (!tooBig) return lca;
      }
      return row;
    }

    function rememberSearchInput(ctx, input) {
      ctx.searchInput = input;
      ctx.searchRow = searchRowFor(input);
      ctx.searchPanel = searchPanelFor(input, ctx.searchRow);
    }

    async function stageOpenSearch(ctx, signal) {
      let input = find('tagCodeInput', ctx);
      if (!input) {
        const toggle = await waitFind('searchModeToggle', ctx, signal);
        await found(toggle);
        const cls = toggle.el.classList;
        if (cls.contains('yw-toggle-closed') || !cls.contains('yw-toggle-open')) {
          D.simulateClick(toggle.el);
          await waitIdle(signal);
        }
        input = await waitFind('tagCodeInput', ctx, signal);
      }
      await found(input);
      rememberSearchInput(ctx, input.el);
    }

    /** Types the Tag Code (if needed), triggers Search and waits for the result list to settle. */
    async function runSearch(ctx, signal) {
      let input = ctx.searchInput;
      if (!input || !input.isConnected || !D.isVisible(input)) {
        const hit = await waitFind('tagCodeInput', ctx, signal);
        input = hit.el;
        rememberSearchInput(ctx, input);
      }
      if (input.value !== ctx.code) {
        const res = await D.setZkInputValue(input, ctx.code, { bridge });
        if (!res.ok) throw new PtaeError('FIELD', 'Could not type the Tag Code into the search field.');
        await waitIdle(signal);
      }
      const seq = await auSeq();
      const btn = find('searchButton', ctx);
      if (btn) {
        if (!ctx.searchButtonLogged) {
          ctx.searchButtonLogged = true;
          await found(btn);
        }
        D.simulateClick(btn.el);
      } else {
        D.pressKey(input, 'Enter');
      }
      let answered = await waitAuAfter(seq, signal);
      if (!answered && !btn && bridge) {
        const token = D.markTarget(input);
        try {
          await bridge.call('fireOk', { token });
        } catch (_) {
          /* no onOK listener */
        } finally {
          D.unmarkTarget(input);
        }
        answered = await waitAuAfter(seq, signal);
      }
      await waitIdle(signal, { timeout: cfg.budgets.search });
      const list = ctx.listbox && ctx.listbox.isConnected ? ctx.listbox : document.body;
      await D.waitDomStable(list, 500, 4000, signal);
    }

    /** Tag Code shown by the record editor (input value, or plain text next to the label). */
    function readEditorCode(ctx) {
      const hit = PTAE.sel.inputInEditor(cfg.tagCodeLabels, cfg.descriptionLabels, ctx);
      if (hit) return D.normText(hit.input.value);
      for (const label of D.findLabelElements(cfg.tagCodeLabels, { exclude: PTAE.sel.nonEditorAreas(ctx) })) {
        const text = D.textAfterLabel(label);
        if (text) return text;
      }
      return null;
    }

    /** Description field: labelled field first, then "value equals a grid cell", then the PRD fallback ID. */
    function resolveDescription(ctx) {
      const primary = find('descInput', ctx, { tiers: ['primary'] });
      const exclude = PTAE.sel.nonEditorAreas(ctx);
      const cells = ctx.row ? rowCells(ctx.row).map((td) => D.textOf(td)).filter((t) => t && !D.eqi(t, ctx.code)) : [];
      const byValue = cells.length
        ? D.findAll(D.TEXT_INPUTS, { exclude }).filter((i) => D.isEditable(i) && cells.includes(D.normText(i.value)))
        : [];
      if (primary) {
        if (byValue.length && !byValue.includes(primary.el)) primary.disagrees = true;
        return primary;
      }
      if (byValue.length === 1) return { el: byValue[0], tier: 'primary', strategy: 'input value equals a grid cell', key: 'descInput' };
      return find('descInput', ctx, { tiers: ['fallback'] });
    }

    async function verifyIdentity(ctx, signal) {
      let seen = null;
      try {
        await D.waitFor(() => {
          checkFatal(signal);
          seen = readEditorCode(ctx);
          return seen === D.normText(ctx.code);
        }, waitOpts(signal, 'record details to open'));
        await log('info', `Editor shows Tag Code ${ctx.code} ✓`);
        return;
      } catch (err) {
        if (!(err instanceof D.TimeoutError)) throw err;
      }
      const dlg = blockingDialog();
      if (dlg) throw new PtaeError('DIALOG', `A Backoffice dialog is blocking the run: "${dlg}". Close it and retry.`);
      if (seen) throw new PtaeError('IDENTITY', `Editor shows Tag Code "${seen}", expected "${ctx.code}" — aborting without changes.`);
      if (!ctx.codeInGrid) throw new PtaeError('IDENTITY', `Could not verify the record for Tag Code ${ctx.code} — aborting without changes.`);
      if (!resolveDescription(ctx)) {
        throw new PtaeError('FIELD', `Record details did not open. Visible labels: ${D.describeVisibleLabels(document.body)}`);
      }
      await log('warn', 'The editor shows no Tag Code field — relying on the exact grid match.');
    }

    async function stageSelectRow(ctx, signal) {
      const hit = find('resultRows', ctx);
      const rows = hit ? hit.els : [];
      if (!rows.length) throw new PtaeError('NOT_FOUND', MSG.notFound(ctx.code));
      const pick = PTAE.pickRow(rows, ctx.code, cfg);
      if (pick.error === 'ambiguous') {
        throw new PtaeError('AMBIGUOUS', `Tag Code ${ctx.code}: ${pick.count} result rows show this code — refine the search manually.`);
      }
      if (pick.error) throw new PtaeError('NOT_FOUND', `${MSG.notFound(ctx.code)} (${pick.count} results, none with exactly this code)`);
      ctx.row = pick.row;
      ctx.listbox = pick.row.closest('.z-listbox');
      ctx.codeIndex = pick.codeIndex;
      ctx.codeInGrid = pick.exact;
      await log('info', `Result row found (${hit.tier}${pick.exact ? ', exact Tag Code match' : ', single result'}).`);
      const cell = pick.codeIndex >= 0 ? rowCells(pick.row)[pick.codeIndex] : null;
      const target = (cell && cell.querySelector('.yw-listview-cell-label')) || cell || firstLabelCell(pick.row);
      D.simulateClick(target);
      await waitIdle(signal);
      await verifyIdentity(ctx, signal);
    }

    // --- Stage 4: review, confirm, amend, save, verify -----------------------------------------------
    async function stageReview(ctx) {
      const hit = resolveDescription(ctx);
      if (!hit) throw new PtaeError('FIELD', `Could not find the tag description field. Visible labels: ${D.describeVisibleLabels(document.body)}`);
      await found(hit);
      if (hit.disagrees) await log('warn', 'The labelled field differs from the values in the result row — check the old value carefully.');
      ctx.descEl = hit.el;
      const oldDesc = hit.el.value;
      const cells = rowCells(ctx.row).map((td) => D.textOf(td));
      ctx.descColumn = cells.findIndex((t, i) => i !== ctx.codeIndex && t !== '' && t === D.normText(oldDesc));
      await send('CS_STAGE', { stage: 'REVIEW', data: { oldDesc, descColumn: ctx.descColumn } });
      await log('info', `Current description in Hybris: "${oldDesc}"`);
      if (ctx.descColumn < 0) await log('warn', 'The result grid does not show this description — verification will re-open the record.');
      return oldDesc;
    }

    async function captureEvidence(kind, els, color) {
      const restore = (els || []).filter(Boolean).map((el) => D.highlight(el, color));
      try {
        await D.sleep(250);
        const res = await send('CS_CAPTURE', { kind });
        if (res && res.ok) await log('info', `Screenshot saved (${kind}).`);
        else await log('warn', `Screenshot (${kind}) unavailable: ${(res && res.error) || 'no response'}`);
        return res;
      } finally {
        restore.forEach((fn) => fn());
      }
    }

    function waitConfirmation(signal) {
      return new Promise((resolve, reject) => {
        const me = active;
        const onAbort = () => {
          clearTimeout(timer);
          me.confirm = null;
          reject(new D.AbortError(signal.reason));
        };
        const done = (value) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          me.confirm = null;
          resolve(value);
        };
        const timer = setTimeout(() => done(null), cfg.budgets.confirm);
        me.confirm = (approve) => done(!!approve);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    async function confirmGate(ctx, oldDesc, signal) {
      const answer = waitConfirmation(signal); // armed before notifying, so a fast reply is never lost
      await send('CS_AWAIT_CONFIRM', { code: ctx.code, oldDesc, newDesc: ctx.newDesc });
      await log('info', `Waiting for confirmation: "${oldDesc}" → "${ctx.newDesc}"`);
      const approved = await answer;
      if (approved === null) throw new PtaeError('CANCELLED', 'Confirmation timed out — no changes made.');
      if (!approved) throw new PtaeError('CANCELLED', 'Cancelled by operator — no changes made.');
    }

    async function amend(ctx, oldDesc, signal) {
      let el = ctx.descEl;
      if (!el || !el.isConnected || !D.isVisible(el)) {
        const hit = resolveDescription(ctx);
        if (!hit) throw new PtaeError('FIELD', 'The tag description field disappeared — aborting without saving.');
        el = ctx.descEl = hit.el;
      }
      if (el.value !== oldDesc) throw new PtaeError('FIELD', `The description changed since review (now "${el.value}") — aborting without saving.`);
      await log('info', `[4/4] Writing the new description "${ctx.newDesc}"…`);
      ctx.amended = true;
      const res = await D.setZkInputValue(el, ctx.newDesc, { bridge });
      if (!res.synced) await log('warn', 'ZK widget sync unavailable — relying on DOM events.');
      await waitIdle(signal);
      const now = ctx.descEl.isConnected ? ctx.descEl : (resolveDescription(ctx) || {}).el;
      if (!now || now.value !== ctx.newDesc) throw new PtaeError('FIELD', 'The new description did not stick in the field — aborting without saving.');
      ctx.descEl = now;
    }

    /** After a failure between "field edited" and "saved": discard the edit so Backoffice is left clean. */
    async function revertUnsaved(ctx) {
      if (!ctx || !ctx.amended || ctx.saved) return;
      try {
        const anchor = ctx.descEl && ctx.descEl.isConnected ? ctx.descEl : null;
        const discard = anchor ? PTAE.sel.nearestButton(anchor, cfg.discardButtons, { exclude: PTAE.sel.nonEditorAreas(ctx) }) : null;
        if (discard) {
          D.simulateClick(discard);
          await waitIdle(null, { timeout: 5000 });
          await log('warn', `Discarded the unsaved change ("${D.textOf(discard) || discard.title}").`);
          return;
        }
        const field = anchor || (resolveDescription(ctx) || {}).el;
        if (field && ctx.oldDesc != null && field.value !== ctx.oldDesc) {
          await D.setZkInputValue(field, ctx.oldDesc, { bridge });
          await waitIdle(null, { timeout: 5000 });
          await log('warn', `Put back the original value "${ctx.oldDesc}" (nothing was saved).`);
        }
      } catch (_) {
        /* best effort: the original failure is what gets reported */
      }
    }

    function watchText(pattern) {
      let match = '';
      const obs = new MutationObserver((records) => {
        if (match) return;
        for (const r of records) {
          for (const n of r.addedNodes) {
            const t = n.nodeType === 1 ? D.textOf(n) : n.nodeType === 3 ? D.normText(n.nodeValue) : '';
            if (t && t.length < 300 && pattern.test(t)) {
              match = t;
              return;
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      return () => {
        obs.disconnect();
        return match;
      };
    }

    const ERROR_UI = '.z-errorbox, .z-errbox, [class*="notification" i], .z-messagebox-window, .z-window-modal';

    /** Error shown after Save; elements already visible before the click (`seen`) are ignored. */
    function saveError(seen) {
      const fresh = (sel) => D.findAll(sel).filter((el) => !seen || !seen.has(el));
      const box = fresh('.z-errorbox, .z-errbox')[0];
      if (box) return D.textOf(box) || 'validation error';
      const note = fresh('[class*="notification" i]').find((n) => /error|fail/i.test(n.className) && D.textOf(n));
      if (note) return D.textOf(note).slice(0, 200);
      const dlg = fresh('.z-messagebox-window, .z-window-modal').find((w) => /error|fail|invalid|cannot|unable|not allowed/i.test(D.textOf(w)));
      return dlg ? D.textOf(dlg).slice(0, 200) : null;
    }

    async function save(ctx, signal) {
      let hit = null;
      try {
        hit = await D.waitFor(() => {
          checkFatal(signal);
          return find('saveButton', ctx);
        }, waitOpts(signal, 'Save button', cfg.budgets.save));
      } catch (err) {
        if (!(err instanceof D.TimeoutError)) throw err;
      }
      const seen = new Set(D.findAll(ERROR_UI));
      const stopWatch = watchText(cfg.successToast);
      let toast = '';
      try {
        const seq = await auSeq();
        ctx.saveClicked = true; // from here on the save may have reached the server
        if (hit) {
          await found(hit);
          D.simulateClick(hit.el);
        } else {
          await log('warn', 'Save button not found — sending Ctrl+S.');
          D.pressKey(ctx.descEl || document.body, 's', { ctrlKey: true });
        }
        await waitAuAfter(seq, signal, 5000);
        await waitIdle(signal, { timeout: cfg.budgets.save });
        await D.sleep(700, signal);
      } finally {
        toast = stopWatch();
      }
      const err = saveError(seen);
      if (err) {
        ctx.saveRejected = true;
        throw new PtaeError('SAVE', `Backoffice rejected the save: ${err}`);
      }
      ctx.saved = true;
      await log(toast ? 'ok' : 'info', toast ? `Backoffice: "${toast}"` : 'Save sent — no confirmation message seen; verifying by search.');
    }

    async function readGridDesc(ctx, signal) {
      const hit = find('verifyCell', ctx);
      if (hit) return { text: D.textOf(hit.el), el: hit.el };
      const same = D.qsa('.yw-listview-cell-label', ctx.row).find((l) => D.normText(D.textOf(l)) === D.normText(ctx.newDesc));
      if (same) return { text: D.textOf(same), el: same };
      // The grid has no description column: re-open the record and read the field instead.
      D.simulateClick(firstLabelCell(ctx.row));
      await waitIdle(signal);
      const field = resolveDescription(ctx);
      return { text: field ? field.el.value : '(field not found)', el: field ? field.el : ctx.row };
    }

    /** Searches again and checks the grid shows the new value: initial check + cfg.verify.cooldownsMs retries. */
    async function verify(ctx, signal) {
      const cooldowns = cfg.verify.cooldownsMs;
      const total = cooldowns.length + 1;
      let observed = '';
      let el = null;
      for (let attempt = 1; attempt <= total; attempt++) {
        if (attempt > 1) {
          const ms = cooldowns[attempt - 2];
          await log('warn', `Not reflected yet — retry ${attempt - 1}/${cooldowns.length} in ${Math.round(ms / 1000)} s…`);
          await D.sleep(ms, signal);
        }
        await log('info', `Verifying: searching Tag Code ${ctx.code} again (attempt ${attempt}/${total})…`);
        await runSearch(ctx, signal);
        const hit = find('resultRows', ctx);
        const pick = hit ? PTAE.pickRow(hit.els, ctx.code, cfg) : { error: 'none' };
        if (!pick.row) {
          observed = '(row not found)';
          el = null;
          await log('warn', `Tag Code ${ctx.code} not in the refreshed results.`);
          continue;
        }
        ctx.row = pick.row;
        const read = await readGridDesc(ctx, signal);
        observed = read.text;
        el = read.el;
        if (D.normText(observed) === D.normText(ctx.newDesc)) {
          await log('ok', `Verified in the result grid: "${observed}" (attempt ${attempt}/${total}).`);
          return { verified: true, attempts: attempt, observed, el };
        }
        await log('warn', `Grid shows "${observed}".`);
      }
      return { verified: false, attempts: total, observed, el };
    }

    // --- Pipeline ----------------------------------------------------------------------------------
    function newContext(job) {
      return {
        cfg,
        roleName: job.roleName || cfg.roleName,
        code: job.code,
        newDesc: job.newDesc,
        descColumn: -1,
        codeIndex: -1,
        oldDesc: null,
        amended: false, // field edited in the UI
        saveClicked: false, // Save pressed (the change may have reached the server)
        saveRejected: false, // Backoffice refused the save
        saved: false,
      };
    }

    async function pipeline(job, ctx, signal) {
      await log('info', `Run for Tag ${job.code} → "${job.newDesc}" on ${location.host}`);
      if (bridge && !(await bridge.ready())) await log('warn', 'ZK bridge not available — falling back to DOM events.');
      await waitIdle(signal, { timeout: cfg.budgets.shell });

      await stageAuth(job, ctx, signal);
      const dlg = blockingDialog();
      if (dlg) throw new PtaeError('DIALOG', `A Backoffice dialog is open: "${dlg}". Close it and retry.`);

      await stageNavigate(ctx, signal);
      await log('info', '[3/4] Searching for the Tag Code…');
      await stageOpenSearch(ctx, signal);
      await runSearch(ctx, signal);
      await stageSelectRow(ctx, signal);
      const oldDesc = await stageReview(ctx);
      ctx.oldDesc = oldDesc;

      // Page reloaded after a save in this same job: the field already holds the new value.
      const savedEarlier = job.oldDesc != null && job.oldDesc !== job.newDesc && oldDesc === job.newDesc;
      const recordedOld = savedEarlier ? job.oldDesc : oldDesc;

      if (oldDesc === job.newDesc && !savedEarlier) {
        await log('ok', `Already up to date — Tag ${job.code} is "${oldDesc}".`);
        await captureEvidence('after', [ctx.row, ctx.descEl], 'green');
        return {
          outcome: 'already-up-to-date',
          oldDesc,
          newDesc: job.newDesc,
          verify: null,
          message: `Tag ${job.code} already shows "${oldDesc}" — nothing changed.`,
        };
      }

      if (savedEarlier) {
        await log('info', `Saved before the page reloaded ("${recordedOld}" → "${job.newDesc}") — verifying.`);
      } else {
        await captureEvidence('before', [ctx.row, ctx.descEl], 'amber');
        if (job.confirmBeforeSave) await confirmGate(ctx, oldDesc, signal);
        await amend(ctx, oldDesc, signal);
        await send('CS_STAGE', { stage: 'SAVE', data: {} });
        await save(ctx, signal);
      }

      const v = await verify(ctx, signal);
      await captureEvidence('after', [v.el || ctx.row], v.verified ? 'green' : 'red');
      const verifyInfo = { attempts: v.attempts, observed: v.observed, matched: v.verified };
      if (!v.verified) {
        return {
          outcome: 'failed',
          code: 'VERIFY',
          oldDesc: recordedOld,
          newDesc: job.newDesc,
          verify: verifyInfo,
          message: `Change not reflected after ${cfg.verify.cooldownsMs.length} retries — grid shows "${v.observed}" (expected "${job.newDesc}").`,
        };
      }
      return {
        outcome: 'success',
        oldDesc: recordedOld,
        newDesc: job.newDesc,
        verify: verifyInfo,
        message: `Tag ${job.code}: "${recordedOld}" → "${job.newDesc}" — verified (attempt ${v.attempts}).`,
      };
    }

    async function failure(err, signal, ctx) {
      // Leave Backoffice clean for the next tag: drop an edit that never reached the server.
      const unsaved = ctx && ctx.amended && !ctx.saved && (!ctx.saveClicked || ctx.saveRejected);
      if ((signal && signal.aborted) || err instanceof D.AbortError) {
        if (unsaved) await revertUnsaved(ctx);
        const reason = signal && signal.reason;
        return { outcome: 'aborted', code: 'ABORTED', oldDesc: ctx && ctx.oldDesc, message: String((reason && reason.message) || reason || 'Stopped.') };
      }
      const e = await diagnose(err);
      if (e.code === 'CANCELLED') {
        await log('warn', e.message);
        return { outcome: 'cancelled', code: e.code, oldDesc: ctx && ctx.oldDesc, message: e.message };
      }
      await log('error', e.message);
      await captureEvidence('failure', [], null);
      if (unsaved) await revertUnsaved(ctx);
      return { outcome: 'failed', code: e.code, oldDesc: ctx && ctx.oldDesc, message: e.message };
    }

    async function run(job) {
      if (!job || !job.id) return;
      if (active && active.jobId === job.id) return; // already running this job
      if (active) active.controller.abort('Superseded by a newer run');
      const me = { jobId: job.id, controller: new AbortController(), confirm: null, timer: null };
      active = me;
      fatal = null;
      me.timer = setInterval(() => send('CS_HEARTBEAT', { jobId: job.id }), 15000);
      const ctx = newContext(job);
      let result;
      try {
        result = await pipeline(job, ctx, me.controller.signal);
      } catch (err) {
        if (err instanceof NavigationPending) {
          clearInterval(me.timer);
          if (active === me) active = null;
          return; // the next page load resumes the job
        }
        result = await failure(err, me.controller.signal, ctx);
      }
      clearInterval(me.timer);
      if (active === me) active = null;
      await send('CS_RESULT', { jobId: job.id, result });
    }

    return {
      run,
      abort(reason) {
        if (active) active.controller.abort(reason || 'Stopped by operator');
      },
      confirm(approve) {
        if (active && active.confirm) active.confirm(approve);
      },
      isRunning: () => !!active,
    };
  }

  PTAE.createRunner = createRunner;
  PTAE.PtaeError = PtaeError;

  // --- Extension bootstrap (skipped outside the extension, e.g. in the test pages) ---------------
  (function bootstrap() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
    const previous = root.__PTAE_CS__;
    if (previous && previous.alive()) return; // already running in this page
    if (previous && previous.dispose) previous.dispose(); // orphan left by a reloaded extension

    const transport = {
      send(type, payload) {
        return new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(Object.assign({ type }, payload), (resp) => {
              void chrome.runtime.lastError;
              resolve(resp);
            });
          } catch (_) {
            resolve(undefined); // extension context invalidated
          }
        });
      },
    };
    const bridge = D.createBridgeClient();
    const runner = createRunner({ transport, bridge });

    const onMessage = (msg, sender, sendResponse) => {
      if (!msg || sender.id !== chrome.runtime.id) return false;
      switch (msg.type) {
        case 'BG_PING':
          sendResponse({ ok: true, href: location.href });
          break;
        case 'BG_RUN':
          runner.run(msg.job);
          sendResponse({ ok: true });
          break;
        case 'BG_ABORT':
          runner.abort(msg.reason);
          sendResponse({ ok: true });
          break;
        case 'BG_CONFIRM':
          runner.confirm(!!msg.approve);
          sendResponse({ ok: true });
          break;
        default:
          break;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(onMessage);

    root.__PTAE_CS__ = {
      alive() {
        try {
          return !!chrome.runtime.id;
        } catch (_) {
          return false;
        }
      },
      dispose() {
        try {
          chrome.runtime.onMessage.removeListener(onMessage);
        } catch (_) {
          /* context gone */
        }
        runner.abort('Extension reloaded');
        bridge.dispose();
      },
    };

    transport.send('CS_READY', { href: location.href }).then((resp) => {
      if (resp && resp.job) runner.run(resp.job);
    });
  })();
})(globalThis);
