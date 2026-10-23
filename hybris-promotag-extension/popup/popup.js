/*
 * Portal UI: login, then tags → processing → review. Settings have their own view; the selected tag
 * (its confirmation or its details) shows beside the run list on wide screens and under it in the popup.
 */
(function () {
  'use strict';
  const P = globalThis.PTAE;
  const $ = (id) => document.getElementById(id);

  const STAGE_TEXT = {
    PREFLIGHT: 'Checking the connection',
    TAB: 'Opening Backoffice',
    AWAIT_SSO: 'Signing in (SSO)',
    ROLE_SUBMIT: 'Selecting the role',
    SHELL: 'Working in Backoffice',
    REVIEW: 'Reading the current value',
    CONFIRM: 'Waiting for you',
    SAVE: 'Saving and verifying',
  };
  // status -> [chip label, chip class]
  const CHIPS = {
    pending: ['Waiting', ''],
    running: ['Running', 'run'],
    awaiting_confirm: ['Needs confirmation', 'attn'],
    succeeded: ['Verified', 'ok'],
    unchanged: ['Already set', 'same'],
    failed: ['Failed', 'fail'],
    skipped: ['Skipped', ''],
    stopped: ['Stopped', ''],
  };
  const DONE = ['succeeded', 'unchanged', 'failed', 'skipped', 'stopped'];
  const NOT_RUN = ['failed', 'skipped', 'stopped'];
  const SHOT_LABEL = { before: 'Before saving', after: 'After saving', failure: 'When it failed', manual: 'Captured by hand' };
  // Same breakpoint as popup.css: list and selected tag side by side (the VM portal in a browser window).
  const WIDE = window.matchMedia('(min-width: 1000px)');

  let state = { auth: null, settings: {}, access: {}, job: null, batch: null, logs: [], lastRunId: null };
  let rows = [blankRow()];
  let setupMode = false;
  let settingsAutoOpened = false;
  let runBatchId = null; // the batch the run view shows
  let picked = null; // the tag the user picked in the run list (-1: none); null: chosen automatically
  let runRowsSig = '';
  let logChoice = null; // the user's open/closed choice for the log; null: open when there are errors
  let logErrors = 0;

  // --- helpers -----------------------------------------------------------------------------------
  function blankRow() {
    return { code: '', desc: '', line: '' };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload), (resp) => {
          const err = chrome.runtime.lastError;
          resolve(resp || { ok: false, error: err ? err.message : 'No response from the extension.' });
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function showError(node, text) {
    node.textContent = text || '';
    node.hidden = !text;
  }

  function note(text, warn) {
    const n = $('parse-note');
    n.className = warn ? 'note warn' : 'note';
    n.textContent = text || '';
    n.hidden = !text;
  }

  function fmtTime(t) {
    return new Date(t).toLocaleTimeString([], { hour12: false });
  }

  function fmtClock(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // Must match PROTOCOL in scripts/background.js.
  const PROTOCOL = 3;

  /** Unpacked extensions load new popup files at once but keep the old service worker until reloaded. */
  function showUpdateBanner(stale) {
    $('update-banner').hidden = !stale;
  }

  /** Handles errors that need more than a message: expired portal session, outdated service worker. */
  function handleSpecialError(resp) {
    if (resp && resp.code === 'AUTH') {
      refresh();
      return true;
    }
    if (resp && /^Unknown request/.test(resp.error || '')) {
      showUpdateBanner(true);
      return true;
    }
    return false;
  }

  $('update-btn').addEventListener('click', () => chrome.runtime.reload());

  function showView(name) {
    $('login-view').hidden = name !== 'login';
    $('portal-view').hidden = name !== 'portal';
  }

  function configured() {
    return !!(state.settings.baseUrl && state.access && state.access.hasOrigin);
  }

  function runActive() {
    return P.batch.isActive(state.batch);
  }

  // --- login view ----------------------------------------------------------------------------------
  function renderLogin() {
    setupMode = !!state.auth.setupRequired;
    $('login-title').textContent = setupMode ? 'Create Portal Login' : 'Promo Tag Portal Login';
    $('setup-hint').hidden = !setupMode;
    $('confirm-wrap').hidden = !setupMode;
    $('login-btn').textContent = setupMode ? 'Create & Login' : 'Login';
    $('login-pass').autocomplete = setupMode ? 'new-password' : 'current-password';
    showView('login');
    setTimeout(() => $('login-user').focus(), 0);
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = $('login-user').value.trim();
    const password = $('login-pass').value;
    if (!userId || !password) return showError($('login-error'), 'Enter your User ID and Password / Access Key.');
    if (setupMode && password !== $('login-pass2').value) return showError($('login-error'), 'The two passwords do not match.');
    const btn = $('login-btn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    showError($('login-error'), '');
    const resp = await send(setupMode ? 'UI_SETUP' : 'UI_LOGIN', { userId, password });
    btn.disabled = false;
    btn.textContent = label;
    if (!resp.ok) {
      showError($('login-error'), resp.error);
      $('login-pass').select();
      return;
    }
    $('login-pass').value = '';
    $('login-pass2').value = '';
    await refresh();
  });

  // --- portal view ---------------------------------------------------------------------------------
  function renderPortal() {
    showView('portal');
    renderWhoami();
    renderSettings();
    renderRunState();
    renderLogs();
  }

  function renderWhoami() {
    const who = `Signed in as ${state.auth.userId}`;
    const until = state.auth.expiresAt ? `Session until ${fmtClock(state.auth.expiresAt)}` : '';
    const box = $('whoami');
    box.textContent = '';
    box.append(el('span', 'who', who));
    if (until) box.append(el('span', 'until', until));
    box.title = [who, until].filter(Boolean).join(' · ');
  }

  // --- settings ------------------------------------------------------------------------------------
  function settingsOpen() {
    return !$('settings-panel').hidden;
  }

  /** Settings replace the workspace while they are open. */
  function toggleSettings(open, keepFocus) {
    const show = open == null ? !settingsOpen() : open;
    if (show === settingsOpen()) return;
    $('settings-panel').hidden = !show;
    $('workspace').hidden = show;
    $('settings-btn').setAttribute('aria-expanded', String(show));
    $('settings-btn').classList.toggle('active', show);
    if (keepFocus) return;
    if (show) $(configured() ? 'settings-back' : 'set-url').focus();
    else $('settings-btn').focus();
  }

  function renderSettings() {
    const s = state.settings;
    const a = state.access || {};
    if (document.activeElement !== $('set-url')) $('set-url').value = s.baseUrl || '';
    if (document.activeElement !== $('set-role')) $('set-role').value = s.roleName || '';
    $('set-confirm').checked = s.confirmBeforeSave !== false;
    $('access-status').textContent = !s.baseUrl ? 'Not configured' : a.hasOrigin ? 'Access granted ✓' : 'Access not granted yet';
    $('shots-status').textContent = a.allUrls ? 'Screenshots: always allowed ✓' : 'Screenshots: when opened from the Backoffice tab';
    $('shots-btn').hidden = !!a.allUrls;
    if (document.activeElement !== $('set-teams-url')) $('set-teams-url').value = s.teamsWebhookUrl || '';
    $('teams-status').textContent = a.teams === 'on' ? 'Auto-reply on ✓' : a.teams === 'no-access' ? 'Access not granted yet' : 'Off';
    $('teams-test-btn').hidden = a.teams !== 'on';
    $('version-line').textContent = `Promo Tag Amendment ${chrome.runtime.getManifest().version}`;
    if (!configured() && !settingsAutoOpened) {
      settingsAutoOpened = true;
      toggleSettings(true);
    }
  }

  async function saveSetting(patch) {
    showError($('settings-error'), '');
    const resp = await send('UI_SETTINGS_SAVE', { settings: patch });
    if (!resp.ok) {
      if (!handleSpecialError(resp)) showError($('settings-error'), resp.error);
      return;
    }
    state.settings = resp.settings;
    state.access = resp.access;
    renderSettings();
    renderRunState();
  }

  $('settings-btn').addEventListener('click', () => toggleSettings());
  $('settings-back').addEventListener('click', () => toggleSettings(false));
  $('ss-edit').addEventListener('click', () => toggleSettings(true));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('portal-view').hidden || !settingsOpen()) return;
    e.preventDefault();
    toggleSettings(false);
  });

  $('grant-btn').addEventListener('click', () => {
    showError($('settings-error'), '');
    const raw = $('set-url').value.trim();
    let origin;
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
      origin = u.origin;
    } catch (_) {
      showError($('settings-error'), 'Enter a valid http(s) URL, e.g. https://backoffice.example.com/backoffice/');
      return;
    }
    // Must be called synchronously in the click: the browser only prompts during a user gesture.
    // The service worker registers the scripts on permissions.onAdded (the prompt may close this popup).
    const granted = chrome.permissions.request({ origins: [`${origin}/*`] });
    saveSetting({ baseUrl: raw, roleName: $('set-role').value, confirmBeforeSave: $('set-confirm').checked });
    granted.then(() => refresh()).catch((err) => showError($('settings-error'), err.message));
  });

  $('set-role').addEventListener('change', () => saveSetting({ roleName: $('set-role').value }));
  $('set-confirm').addEventListener('change', () => saveSetting({ confirmBeforeSave: $('set-confirm').checked }));

  $('shots-btn').addEventListener('click', () => {
    chrome.permissions
      .request({ origins: ['<all_urls>'] })
      .then(() => refresh())
      .catch((err) => showError($('settings-error'), err.message));
  });

  $('teams-save-btn').addEventListener('click', () => {
    showError($('settings-error'), '');
    const raw = $('set-teams-url').value.trim();
    if (!raw) {
      saveSetting({ teamsWebhookUrl: '' }); // turns the Teams reply off
      return;
    }
    let host;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:') throw new Error('scheme');
      host = u.hostname;
    } catch (_) {
      showError($('settings-error'), "Paste the HTTP URL from your flow's trigger (it starts with https://).");
      return;
    }
    // As for the Backoffice URL: the browser only prompts during the click.
    const granted = chrome.permissions.request({ origins: [`https://${host}/*`] });
    saveSetting({ teamsWebhookUrl: raw });
    granted.then(() => refresh()).catch((err) => showError($('settings-error'), err.message));
  });

  $('teams-test-btn').addEventListener('click', async () => {
    showError($('settings-error'), '');
    const btn = $('teams-test-btn');
    btn.disabled = true;
    $('teams-status').textContent = 'Sending test…';
    const resp = await send('UI_TEAMS_TEST');
    btn.disabled = false;
    if (!resp.ok) {
      renderSettings();
      if (!handleSpecialError(resp)) showError($('settings-error'), resp.error);
      return;
    }
    $('teams-status').textContent = 'Test sent ✓ — check the latest Daily Alert thread';
  });

  // --- tag rows (edit) -----------------------------------------------------------------------------
  let draftTimer = null;
  function saveDraft() {
    chrome.storage.session.set({ draft: { rows } }).catch(() => {});
  }
  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 300);
  }
  async function restoreDraft() {
    const { draft } = await chrome.storage.session.get('draft');
    if (draft && Array.isArray(draft.rows) && draft.rows.length) {
      rows = draft.rows.map((r) => Object.assign(blankRow(), r));
    }
  }

  function filledRows() {
    return rows.filter((r) => r.code.trim() || r.desc.trim());
  }

  function updateExecuteLabel() {
    const n = filledRows().length;
    const btn = $('execute-btn');
    btn.textContent = n > 1 ? `Execute ${n} tags` : 'Execute';
    btn.disabled = runActive() || !configured() || n === 0;
    $('rows-meta').textContent = n ? plural(n, 'tag') : '';
    renderExecuteHint();
  }

  function renderExecuteHint() {
    const hint = $('execute-hint');
    const mode = !configured() ? 'setup' : state.settings.confirmBeforeSave !== false ? 'confirm' : 'direct';
    if (hint.dataset.mode === mode) return;
    hint.dataset.mode = mode;
    hint.textContent = '';
    if (mode === 'setup') {
      const open = el('button', 'btn btn-link', 'Open Settings');
      open.type = 'button';
      open.addEventListener('click', () => toggleSettings(true));
      hint.append('Set up Backoffice access first. ', open);
    } else {
      hint.textContent = mode === 'confirm' ? 'You confirm each change before it is saved.' : 'Changes are saved without asking first.';
    }
  }

  function makeInput(cls, value, placeholder, label) {
    const input = el('input', cls);
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', label);
    return input;
  }

  function focusRow(index, field) {
    const items = $('rows').children;
    const li = items[Math.max(0, Math.min(index, items.length - 1))];
    const target = li && li.querySelector(field === 'desc' ? '.row-desc' : '.row-code');
    if (target) target.focus();
  }

  function renderRows() {
    const list = $('rows');
    const active = document.activeElement;
    const kept = list.contains(active) && active.tagName === 'INPUT'
      ? {
        index: [...list.children].indexOf(active.closest('li')),
        field: active.classList.contains('row-desc') ? 'desc' : 'code',
        start: active.selectionStart,
        end: active.selectionEnd,
      }
      : null;
    list.textContent = '';
    rows.forEach((r, i) => {
      const li = document.createElement('li');
      const code = makeInput('row-code', r.code, i === 0 ? '888 — or paste alert' : 'Tag code', `Tag code ${i + 1}`);
      const desc = makeInput('row-desc', r.desc, 'New tag description', `New tag description ${i + 1}`);
      const del = el('button', 'row-remove', '×');
      del.type = 'button';
      del.title = 'Remove this tag';
      del.setAttribute('aria-label', `Remove tag ${i + 1}`);

      const edited = (input) => {
        input.classList.remove('invalid');
        note('');
        showError($('job-error'), '');
        updateExecuteLabel();
        saveDraftSoon();
      };
      code.addEventListener('input', () => {
        rows[i].code = code.value;
        rows[i].line = '';
        edited(code);
      });
      desc.addEventListener('input', () => {
        rows[i].desc = desc.value;
        rows[i].line = '';
        edited(desc);
      });
      code.addEventListener('change', () => {
        if (code.value.includes('||')) applyPasted(code.value, i);
      });
      [code, desc].forEach((input) => input.addEventListener('paste', (e) => onPaste(e, i)));
      // Enter moves through the rows instead of submitting the form.
      code.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        desc.focus();
      });
      desc.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (i < rows.length - 1) focusRow(i + 1, 'code');
        else if (rows[i].code.trim() || rows[i].desc.trim()) addRow();
      });
      del.addEventListener('click', () => removeRow(i));
      li.append(el('span', 'row-num', String(i + 1)), code, desc, del);
      list.append(li);
    });
    if (kept && kept.index >= 0) {
      // A re-render keeps the typing focus.
      focusRow(kept.index, kept.field);
      try {
        document.activeElement.setSelectionRange(kept.start, kept.end);
      } catch (_) {
        /* not a text field any more */
      }
    }
    updateExecuteLabel();
  }

  function addRow() {
    rows.push(blankRow());
    renderRows();
    focusRow(rows.length - 1, 'code');
    saveDraft();
  }

  function removeRow(i) {
    rows.splice(i, 1);
    if (!rows.length) rows = [blankRow()];
    renderRows();
    focusRow(Math.min(i, rows.length - 1), 'code');
    saveDraft();
  }

  function onPaste(e, i) {
    const raw = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!raw) return;
    if (raw.includes('||')) {
      e.preventDefault();
      applyPasted(raw, i);
      return;
    }
    if (/[\r\n]/.test(raw)) {
      e.preventDefault(); // single-line inputs would glue lines together
      const t = e.target;
      t.setRangeText(raw.replace(/\s*[\r\n]+\s*/g, ' ').trim(), t.selectionStart, t.selectionEnd, 'end');
      t.dispatchEvent(new Event('input'));
    }
  }

  /** Turns pasted alert text into rows: the row pasted into is replaced, existing codes are updated. */
  function applyPasted(raw, at) {
    const parsed = P.parser.parseAlerts(raw);
    if (!parsed.items.length) {
      note(parsed.errors[0] || 'No "code || description" line found in the pasted text.', true);
      return;
    }
    const kept = rows.filter((r, idx) => idx !== at && (r.code.trim() || r.desc.trim()));
    let added = 0;
    let updated = 0;
    for (const it of parsed.items) {
      const same = kept.find((r) => r.code.trim() === it.code);
      if (same) {
        same.desc = it.desc;
        same.line = it.line;
        updated++;
      } else {
        kept.push({ code: it.code, desc: it.desc, line: it.line });
        added++;
      }
    }
    rows = kept.length ? kept : [blankRow()];
    renderRows();
    const parts = [];
    if (added) parts.push(`${added} tag${added === 1 ? '' : 's'} added from the alert`);
    if (updated) parts.push(`${updated} updated`);
    const extra = parsed.errors.concat(parsed.warnings);
    note(`${parts.join(', ')}. Check the rows, then Execute.${extra.length ? `\n${extra.join('\n')}` : ''}`, extra.length > 0);
    saveDraft();
  }

  /** Flags invalid or duplicate rows; returns true when everything is fine. */
  function markInvalid() {
    const codes = new Map();
    let ok = true;
    $('rows').querySelectorAll('li').forEach((li, i) => {
      const r = rows[i];
      const codeInput = li.querySelector('.row-code');
      const descInput = li.querySelector('.row-desc');
      codeInput.classList.remove('invalid');
      descInput.classList.remove('invalid');
      if (!r.code.trim() && !r.desc.trim()) return;
      const code = r.code.trim();
      const dup = codes.has(code);
      codes.set(code, true);
      if (P.parser.validateCode(code) || dup) {
        codeInput.classList.add('invalid');
        ok = false;
      }
      if (P.parser.validateDesc(r.desc)) {
        descInput.classList.add('invalid');
        ok = false;
      }
    });
    return ok;
  }

  $('add-row').addEventListener('click', addRow);

  $('job-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('job-error'), '');
    note('');
    // A "code || description" typed into a Tag Code box is split before running.
    rows.forEach((r) => {
      if (!r.code.includes('||')) return;
      const p = P.parser.parseAlert(r.code);
      if (!p.error) Object.assign(r, { code: p.code, desc: p.desc, line: r.code.trim() });
    });
    renderRows();
    const valid = markInvalid();
    const { items, errors } = P.batch.normalizeItems(rows.map((r) => ({ code: r.code, newDesc: r.desc, rawLine: r.line })), P.parser);
    if (!valid || errors.length) return showError($('job-error'), errors.slice(0, 3).join('\n') || 'Fix the highlighted rows.');
    if (!items.length) return showError($('job-error'), 'Add at least one Tag Code with its new description.');
    $('execute-btn').disabled = true;
    const resp = await send('UI_BATCH_START', { items });
    if (!resp.ok) {
      updateExecuteLabel();
      if (!handleSpecialError(resp)) showError($('job-error'), resp.error);
      return;
    }
    rows = [blankRow()];
    saveDraft();
    await refresh();
  });

  // --- screenshots (from History) ---------------------------------------------------------------------
  const shotCache = new Map(); // runId -> { key, promise of [{ kind, takenAt, url }] }

  /** A tag's screenshots; `key` changes when new ones may exist (a new stage or outcome). */
  function loadShots(runId, key) {
    const hit = shotCache.get(runId);
    if (hit && hit.key === key) return hit.promise;
    if (hit) setTimeout(() => revokeShots(hit.promise), 5000); // after the new images replaced them
    const db = P.historyDb;
    const promise = (db ? db.getScreenshotsForRun(runId) : Promise.resolve([]))
      .then((list) => (list || []).filter((s) => s && s.blob).map((s) => ({ kind: s.kind, takenAt: s.takenAt, url: URL.createObjectURL(s.blob) })))
      .catch(() => []);
    shotCache.set(runId, { key, promise });
    return promise;
  }

  function revokeShots(promise) {
    promise.then((list) => list.forEach((s) => URL.revokeObjectURL(s.url)));
  }

  function forgetShots(runId) {
    const hit = shotCache.get(runId);
    if (hit) revokeShots(hit.promise);
    shotCache.delete(runId);
  }

  function clearShots() {
    shotCache.forEach((hit) => revokeShots(hit.promise));
    shotCache.clear();
    $('cf-shot').dataset.run = '';
    $('td-shots').dataset.run = '';
  }

  /** The before shot is taken right before the confirmation, the after/failure shot at the end. */
  function shotKey(it, job) {
    const before = !!job && job.itemIndex === it.index && (job.stage === 'CONFIRM' || job.stage === 'SAVE');
    return `${it.status}${before ? '+before' : ''}${it.shotMissing ? '+missing' : ''}`;
  }

  function shotFigure(shot, runId) {
    const label = SHOT_LABEL[shot.kind] || shot.kind;
    const fig = el('figure');
    const btn = el('button', 'shot-btn');
    btn.type = 'button';
    btn.title = 'Open in History';
    const img = el('img');
    img.src = shot.url;
    img.alt = `${label} screenshot`;
    btn.append(img);
    btn.addEventListener('click', () => send('UI_OPEN_HISTORY', { runId }));
    fig.append(btn, el('figcaption', null, `${label} · ${fmtTime(shot.takenAt)}`));
    return fig;
  }

  // --- run view ------------------------------------------------------------------------------------
  function runJob(b) {
    return b && state.job && state.job.batchId === b.id ? state.job : null;
  }

  function pendingConfirm() {
    const job = state.job;
    return job && job.status === 'awaiting_confirm' ? job.pendingConfirm : null;
  }

  /** Wide screens show a tag's details unasked: the current one, after the run the first failed one. */
  function autoIndex(b) {
    if (!WIDE.matches) return -1;
    if (P.batch.isActive(b)) {
      const job = runJob(b);
      return job ? job.itemIndex : Math.max(0, b.current);
    }
    return Math.max(0, b.items.findIndex((it) => it.status === 'failed'));
  }

  /** The tag whose details show. */
  function detailIndex(b) {
    if (!b) return -1;
    if (picked != null) return picked < b.items.length ? picked : -1;
    return autoIndex(b);
  }

  function runSummary(b) {
    const s = P.batch.summary(b);
    const parts = [];
    if (s.succeeded) parts.push(`${s.succeeded} verified`);
    if (s.unchanged) parts.push(`${s.unchanged} already set`);
    if (s.failed) parts.push(`${s.failed} failed`);
    if (s.skipped + s.stopped) parts.push(`${s.skipped + s.stopped} not run`);
    return `${b.status === 'stopped' ? 'Stopped' : 'Finished'} — ${parts.join(' · ') || 'nothing done'}`;
  }

  /** One line under the tag: old → new, or what is happening, or why it failed (cut to fit). */
  function subLine(it, job) {
    const sub = el('span', 'tr-sub');
    const quoted = (cls, text) => el('span', cls, `"${text}"`);
    if (it.status === 'succeeded' && it.oldDesc != null) {
      sub.append(quoted('old', it.oldDesc), ' → ', quoted('new', it.newDesc));
      if (it.attempts > 1) sub.append(` · verified on attempt ${it.attempts}`);
    } else if (it.status === 'succeeded') {
      sub.textContent = 'Saved and verified.';
    } else if (it.status === 'unchanged') {
      sub.textContent = 'Already set in Hybris — nothing changed.';
    } else if (NOT_RUN.includes(it.status)) {
      sub.textContent = it.message || (it.status === 'failed' ? 'Failed.' : 'Not run.');
    } else if (job) {
      sub.textContent = it.status === 'awaiting_confirm' ? 'Waiting for your confirmation' : `${STAGE_TEXT[job.stage] || 'Working'}…`;
      if (job.oldDesc != null) sub.append(' · now ', quoted('old', job.oldDesc));
    } else {
      return null;
    }
    sub.title = sub.textContent;
    return sub;
  }

  function chevron() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'tr-chev');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z');
    svg.append(path);
    return svg;
  }

  function runRow(it, i, job, pc, shown) {
    const live = !!job && job.itemIndex === i && (it.status === 'running' || it.status === 'awaiting_confirm');
    const confirming = !!pc && pc.itemIndex === i;
    const btn = el('button', 'tag-row');
    btn.type = 'button';
    btn.dataset.index = String(i);
    btn.classList.toggle('is-current', live);
    btn.classList.toggle('is-attn', it.status === 'awaiting_confirm');
    btn.classList.toggle('is-fail', it.status === 'failed');
    btn.setAttribute('aria-controls', confirming ? 'confirm-panel' : 'tag-detail');
    btn.setAttribute('aria-expanded', String(confirming || i === shown));
    const [label, cls] = CHIPS[it.status] || [it.status, ''];
    const main = el('span', 'tr-main');
    main.append(el('span', 'tr-desc', it.newDesc));
    const sub = subLine(it, live ? job : null);
    if (sub) main.append(sub);
    btn.append(el('span', 'tr-num', String(i + 1)), el('span', 'tr-code', it.code), main, el('span', `chip ${cls}`.trim(), label), chevron());
    btn.addEventListener('click', () => pickTag(i));
    const li = document.createElement('li');
    li.append(btn);
    return li;
  }

  function pickTag(i) {
    const b = state.batch;
    if (!b) return;
    const pc = pendingConfirm();
    if (pc && pc.itemIndex === i) {
      $('confirm-panel').scrollIntoView({ block: 'nearest' });
      $('cf-yes').focus();
      return;
    }
    // Wide screens: the details sit beside the list, and picking the current tag follows the run again.
    // Popup: each row opens and closes its own.
    if (WIDE.matches) picked = i === autoIndex(b) ? null : i;
    else picked = detailIndex(b) === i ? -1 : i;
    renderRunState();
    if (detailIndex(b) === i) $('tag-detail').scrollIntoView({ block: 'nearest' });
  }

  function renderRun(pc, shown) {
    const b = state.batch;
    $('job-form').hidden = !!b;
    $('run-view').hidden = !b;
    if (!b) return;
    const active = P.batch.isActive(b);
    const job = runJob(b);
    const s = P.batch.summary(b);
    const done = s.total - s.running - s.pending;
    $('run-title').textContent = !active ? runSummary(b) : b.status === 'stopping' ? 'Stopping…' : `Processing ${plural(s.total, 'tag')}`;
    $('run-meta').textContent = active ? `${done} of ${s.total} done` : plural(s.total, 'tag');
    const bar = $('run-progress');
    bar.className = `progress${active ? '' : s.failed ? ' fail' : b.status === 'stopped' ? ' stop' : ' ok'}`;
    bar.setAttribute('aria-valuemax', String(s.total));
    bar.setAttribute('aria-valuenow', String(done));
    bar.setAttribute('aria-valuetext', `${done} of ${s.total} tags done`);
    $('run-progress-bar').style.width = `${s.total ? Math.round((done / s.total) * 100) : 0}%`;

    // Rebuilt only when something in it changed (not on every heartbeat), so hover and focus stay put.
    const sig = JSON.stringify([b.id, b.items.map((it) => [it.status, it.oldDesc, it.message, it.attempts]),
      job && [job.itemIndex, job.stage, job.oldDesc, job.status], pc && pc.itemIndex, shown, WIDE.matches]);
    if (sig !== runRowsSig) {
      runRowsSig = sig;
      const list = $('run-rows');
      if (list.contains($('tag-detail'))) $('work-side').append($('tag-detail'));
      list.textContent = '';
      b.items.forEach((it, i) => list.append(runRow(it, i, job, pc, shown)));
    }

    const retry = s.failed + s.skipped + s.stopped;
    $('run-actions').hidden = active;
    $('rs-retry').hidden = !retry;
    $('rs-retry').textContent = `Retry failed (${retry})`;
    $('rs-capture').hidden = !b.items.some((it) => it.shotMissing);
    renderTeams(active ? null : b.teams);
  }

  /** Teams reply status under a finished run; a send that never finished counts as failed. */
  function renderTeams(t) {
    const stuck = !!t && t.status === 'sending' && Date.now() - (t.at || 0) > 120000;
    const failed = !!t && (t.status === 'failed' || stuck);
    let text = '';
    if (failed) text = `Teams reply not sent: ${t.error || 'interrupted.'}`;
    else if (t && t.status === 'sending') text = 'Sending the Teams reply…';
    else if (t && t.status === 'sent') text = 'Teams reply sent ✓';
    const n = $('teams-note');
    n.className = failed ? 'note warn' : 'note';
    n.textContent = text;
    n.hidden = !text;
    $('rs-teams').hidden = !failed;
  }

  function renderSteps() {
    const b = state.batch;
    const active = P.batch.isActive(b);
    const at = !b ? 0 : active ? 1 : 2;
    const attention = active && !!pendingConfirm();
    const failed = !!b && !active && P.batch.summary(b).failed > 0;
    $('steps').querySelectorAll('.step').forEach((li, i) => {
      li.classList.toggle('done', i < at);
      li.classList.toggle('current', i === at);
      li.classList.toggle('attention', i === at && attention);
      li.classList.toggle('failed', i === at && failed);
      if (i === at) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  }

  function renderStatus() {
    const b = state.batch;
    const job = state.job;
    let text = 'Success';
    let cls = 'ok';
    if (!b) {
      text = configured() ? 'Ready' : 'Setup needed';
      cls = configured() ? '' : 'confirm';
    } else if (P.batch.isActive(b)) {
      if (job && job.status === 'awaiting_confirm') {
        text = 'Needs confirmation';
        cls = 'confirm';
      } else {
        const i = job && job.batchId === b.id ? job.itemIndex : Math.max(0, b.current);
        text = b.status === 'stopping' ? 'Stopping…' : b.items.length > 1 ? `Running · tag ${i + 1} of ${b.items.length}` : 'Running';
        cls = 'running';
      }
    } else if (b.status === 'stopped') {
      text = 'Stopped';
      cls = '';
    } else if (P.batch.summary(b).failed) {
      text = 'Finished with errors';
      cls = 'fail';
    }
    const pill = $('status-text');
    pill.textContent = text;
    pill.className = `pill ${cls}`.trim();
  }

  function renderConfirm(pc) {
    const panel = $('confirm-panel');
    const appeared = panel.hidden && !!pc;
    if (!pc) {
      const hadFocus = panel.contains(document.activeElement);
      panel.hidden = true;
      if (hadFocus && !$('run-view').hidden) $('run-title').focus();
      return;
    }
    panel.hidden = false;
    const n = pc.itemCount || 1;
    const i = pc.itemIndex || 0;
    const remaining = n - i;
    $('cf-pos').textContent = n > 1 ? `Tag ${i + 1} of ${n}` : '';
    $('cf-code').textContent = pc.code;
    $('cf-old').textContent = pc.oldDesc === '' ? '(empty)' : pc.oldDesc;
    $('cf-new').textContent = pc.newDesc;
    $('cf-all').hidden = remaining < 2;
    $('cf-all').textContent = `Confirm all remaining (${remaining})`;
    $('cf-all').title = `Save this tag and the ${plural(remaining - 1, 'tag')} after it without asking again`;
    $('cf-no').textContent = n > 1 ? 'Skip this tag' : 'Cancel';
    const next = remaining === 2 ? 'the next tag' : `the next ${remaining - 1} tags`;
    $('cf-help').textContent = remaining > 1
      ? `Nothing is saved until you confirm. "Confirm all remaining" also saves ${next} without asking.`
      : 'Nothing is saved in Hybris until you confirm.';
    $('cf-help').hidden = false;
    renderConfirmShot(pc);
    if (appeared) {
      if (settingsOpen()) toggleSettings(false, true);
      panel.scrollIntoView({ block: 'nearest' });
      $('cf-yes').focus();
    }
  }

  /** The Backoffice screenshot taken just before asking, so the operator sees what will change. */
  function renderConfirmShot(pc) {
    const job = state.job;
    const fig = $('cf-shot');
    const runId = (job && job.runId) || '';
    if (fig.dataset.run === runId) return;
    fig.dataset.run = runId;
    fig.hidden = true;
    if (!runId) return;
    const key = shotKey({ index: pc.itemIndex, status: 'awaiting_confirm', shotMissing: false }, job);
    const attempt = (tries) => loadShots(runId, key).then((shots) => {
      if (fig.dataset.run !== runId) return;
      const shot = shots.filter((s) => s.kind === 'before').pop();
      if (shot) {
        $('cf-shot-img').src = shot.url;
        fig.hidden = false;
      } else if (tries > 1) {
        setTimeout(() => {
          if (fig.dataset.run !== runId) return;
          forgetShots(runId);
          attempt(tries - 1);
        }, 1500);
      }
    });
    attempt(3);
  }

  function detailMessage(it) {
    if (!DONE.includes(it.status)) return '';
    const lines = [it.message || ''];
    if (it.status === 'succeeded' && it.attempts > 1) lines.push(`Verified on attempt ${it.attempts}.`);
    if (it.status === 'failed' && it.errorCode) lines.push(`Error code: ${it.errorCode}`);
    return lines.filter(Boolean).join('\n');
  }

  function renderDetail(b, i) {
    const panel = $('tag-detail');
    const it = b && i >= 0 ? b.items[i] : null;
    panel.hidden = !it;
    if (!it) return;
    const job = runJob(b);
    const done = DONE.includes(it.status);
    const live = !!job && job.itemIndex === i && !done && it.status !== 'pending';
    const [label, cls] = CHIPS[it.status] || [it.status, ''];
    $('td-title').textContent = `Tag ${it.code}`;
    $('td-chip').className = `chip ${cls}`.trim();
    $('td-chip').textContent = label;
    $('td-new').textContent = it.newDesc;
    const old = it.oldDesc != null ? it.oldDesc : live ? job.oldDesc : null;
    $('td-old-label').textContent = done ? 'In Hybris before' : 'In Hybris now';
    $('td-old').textContent = old == null ? (done ? 'Not read' : 'Not read yet') : old === '' ? '(empty)' : old;
    const stage = live && it.status === 'running' ? STAGE_TEXT[job.stage] : '';
    $('td-stage').textContent = stage ? `${stage}…` : '';
    $('td-stage').hidden = !stage;
    const msg = detailMessage(it);
    $('td-message').textContent = msg;
    $('td-message-wrap').hidden = !msg;
    panel.classList.toggle('is-fail', it.status === 'failed');
    $('td-foot').hidden = !it.runId;
    $('td-history').dataset.run = it.runId || '';
    renderDetailShots(it, job);
  }

  function renderDetailShots(it, job) {
    const box = $('td-shots');
    const runId = it.runId || '';
    if (box.dataset.run !== runId) {
      box.dataset.run = runId;
      box.dataset.key = '';
      box.textContent = '';
      box.hidden = true;
    }
    const key = shotKey(it, job);
    if (!runId || box.dataset.key === key) return;
    box.dataset.key = key;
    loadShots(runId, key).then((shots) => {
      if (box.dataset.run !== runId || box.dataset.key !== key) return;
      const latest = ['before', 'after', 'failure', 'manual'].map((kind) => shots.filter((s) => s.kind === kind).pop()).filter(Boolean);
      box.textContent = '';
      latest.forEach((shot) => box.append(shotFigure(shot, runId)));
      box.hidden = !latest.length;
    });
  }

  function renderSummary() {
    const s = state.settings;
    const a = state.access || {};
    let host = s.baseUrl || '';
    try {
      host = new URL(s.baseUrl).host;
    } catch (_) {
      /* shown as typed */
    }
    $('ss-backoffice').textContent = !s.baseUrl ? 'Not set up' : a.hasOrigin ? host : `${host} (no access yet)`;
    $('ss-backoffice').title = s.baseUrl || '';
    $('ss-role').textContent = s.roleName || '—';
    $('ss-confirm').textContent = s.confirmBeforeSave !== false ? 'Confirm each change' : 'Save without asking';
    $('ss-teams').textContent = a.teams === 'on' ? 'Auto-reply on' : a.teams === 'no-access' ? 'Access not granted yet' : 'Off';
  }

  /** Beside the list (wide) or around it (popup): the confirmation, the picked tag, the run settings. */
  function renderSide(pc, shown) {
    const b = state.batch;
    const summary = !b && !pc && WIDE.matches;
    $('setup-summary').hidden = !summary;
    if (summary) renderSummary();
    renderConfirm(pc);
    const index = pc && pc.itemIndex === shown ? -1 : shown;
    renderDetail(b, index);
    const detail = $('tag-detail');
    const rowLi = !WIDE.matches && index >= 0 ? $('run-rows').children[index] : null;
    const host = rowLi || $('work-side');
    if (detail.parentNode !== host) host.append(detail);
    const side = summary || !!pc || (!detail.hidden && host === $('work-side'));
    $('work-side').hidden = !side;
    $('work-grid').classList.toggle('has-side', side);
    $('work-grid').classList.toggle('is-confirming', !!pc);
  }

  /** Re-rendering may rebuild the run rows or move the details: keep the keyboard focus where it was. */
  function keepFocus(render) {
    const a = document.activeElement;
    const row = a && a.classList && a.classList.contains('tag-row') ? a.dataset.index : null;
    const id = a && a.id;
    render();
    if (document.activeElement && document.activeElement !== document.body) return;
    const target = row != null ? $('run-rows').querySelector(`.tag-row[data-index="${row}"]`) : id ? $(id) : null;
    if (target && target.getClientRects().length) target.focus({ preventScroll: true });
  }

  function renderRunState() {
    keepFocus(() => {
      const b = state.batch;
      if ((b ? b.id : null) !== runBatchId) {
        runBatchId = b ? b.id : null;
        picked = null;
        showError($('run-error'), '');
        clearShots();
      }
      const pc = pendingConfirm();
      const shown = detailIndex(b);
      renderSteps();
      renderStatus();
      renderRun(pc, shown);
      renderSide(pc, shown);
      const active = runActive();
      $('stop-btn').hidden = !active;
      $('stop-btn').disabled = !!b && b.status === 'stopping';
      $('settings-back-label').textContent = !b ? 'Back to tags' : active ? 'Back to the run' : 'Back to results';
      updateExecuteLabel();
    });
  }

  WIDE.addEventListener('change', () => {
    if (!$('portal-view').hidden) renderRunState();
  });

  async function answerConfirm(approve, all) {
    const job = state.job;
    if (!job) return;
    const buttons = ['cf-yes', 'cf-all', 'cf-no'].map($);
    buttons.forEach((btn) => { btn.disabled = true; });
    const resp = await send('UI_JOB_CONFIRM', { jobId: job.id, approve, all });
    buttons.forEach((btn) => { btn.disabled = false; });
    if (!resp.ok && !handleSpecialError(resp)) showError($('run-error'), resp.error);
  }
  $('cf-yes').addEventListener('click', () => answerConfirm(true, false));
  $('cf-all').addEventListener('click', () => answerConfirm(true, true));
  $('cf-no').addEventListener('click', () => answerConfirm(false, false));
  $('cf-shot-btn').addEventListener('click', () => send('UI_OPEN_HISTORY', { runId: $('cf-shot').dataset.run }));
  $('td-history').addEventListener('click', () => send('UI_OPEN_HISTORY', { runId: $('td-history').dataset.run }));

  $('stop-btn').addEventListener('click', () => send('UI_JOB_STOP'));
  $('clear-log-btn').addEventListener('click', () => send('UI_CLEAR_LOG'));
  $('history-btn').addEventListener('click', () => send('UI_OPEN_HISTORY'));
  $('rs-open').addEventListener('click', () => send('UI_OPEN_HISTORY'));

  async function newRun(nextRows) {
    const resp = await send('UI_BATCH_CLEAR');
    if (!resp.ok) {
      if (!handleSpecialError(resp)) showError($('run-error'), resp.error);
      return;
    }
    rows = nextRows && nextRows.length ? nextRows : [blankRow()];
    saveDraft();
    note(nextRows && nextRows.length ? `${nextRows.length} tag${nextRows.length > 1 ? 's' : ''} loaded for retry — check them, then Execute.` : '');
    await refresh();
    focusRow(0, 'code');
  }
  $('rs-new').addEventListener('click', () => newRun(null));
  $('rs-retry').addEventListener('click', () => {
    const again = (state.batch ? state.batch.items : [])
      .filter((it) => NOT_RUN.includes(it.status))
      .map((it) => ({ code: it.code, desc: it.newDesc, line: it.rawLine || '' }));
    newRun(again);
  });
  $('rs-teams').addEventListener('click', async () => {
    $('rs-teams').disabled = true;
    const resp = await send('UI_TEAMS_RETRY'); // the outcome shows in the Teams note
    $('rs-teams').disabled = false;
    if (!resp.ok) handleSpecialError(resp);
  });
  $('rs-capture').addEventListener('click', async () => {
    showError($('run-error'), '');
    const resp = await send('UI_CAPTURE_NOW', { runId: state.lastRunId });
    if (!resp.ok) {
      if (!handleSpecialError(resp)) showError($('run-error'), resp.error);
      return;
    }
    $('rs-capture').hidden = true;
    forgetShots(state.lastRunId);
    $('td-shots').dataset.key = '';
    renderRunState();
  });

  $('logout-btn').addEventListener('click', async () => {
    await send('UI_LOGOUT');
    rows = [blankRow()];
    note('');
    await refresh();
  });

  // --- activity log --------------------------------------------------------------------------------
  function renderLogs() {
    const logs = state.logs || [];
    const list = $('log-console');
    // Follow new entries, unless the operator scrolled up to read; a log that just opened shows the latest.
    const atEnd = $('log-body').hidden || list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    const errors = logs.filter((entry) => entry.level === 'error').length;
    if (errors > logErrors) logChoice = null; // a new error opens the log again
    logErrors = errors;
    const open = logChoice != null ? logChoice : errors > 0;
    $('log-toggle').setAttribute('aria-expanded', String(open));
    $('log-body').hidden = !open;
    $('log-count').textContent = logs.length ? `· ${logs.length} ${logs.length === 1 ? 'entry' : 'entries'}` : '';
    $('log-flag').textContent = errors ? plural(errors, 'error') : '';
    $('log-flag').hidden = !errors;
    $('clear-log-btn').disabled = !logs.length;

    list.textContent = '';
    const frag = document.createDocumentFragment();
    for (const entry of logs) {
      const li = el('li', entry.level || 'info');
      li.append(el('time', null, fmtTime(entry.t)), document.createTextNode(entry.msg));
      frag.append(li);
    }
    list.append(frag);
    if (atEnd) list.scrollTop = list.scrollHeight;
  }

  $('log-toggle').addEventListener('click', () => {
    logChoice = $('log-toggle').getAttribute('aria-expanded') !== 'true';
    renderLogs();
  });

  // --- Daily Alert link ------------------------------------------------------------------------------
  /** Tags from an "Open in Promo Tag Portal" link replace the form, and a finished run's results. */
  async function takeImport() {
    const resp = await send('UI_IMPORT_TAKE');
    const imp = resp.ok ? resp.import : null;
    if (!imp) return null;
    if (state.batch) {
      if (!(await send('UI_BATCH_CLEAR')).ok) return null;
      Object.assign(state, { batch: null, job: null, logs: [] });
    }
    rows = imp.items.length ? imp.items.map((it) => ({ code: it.code, desc: it.desc, line: it.line })) : [blankRow()];
    saveDraft();
    return imp;
  }

  function noteImport(imp) {
    const n = imp.items.length;
    const extra = imp.errors.concat(imp.warnings);
    const head = n ? `${n} tag${n === 1 ? '' : 's'} loaded from the Daily Alert. Check them, then Execute.` : 'The Daily Alert link had no "code || description" lines.';
    note(`${head}${extra.length ? `\n${extra.join('\n')}` : ''}`, !n || extra.length > 0);
  }

  // --- state sync ----------------------------------------------------------------------------------
  async function refresh() {
    const resp = await send('UI_STATE');
    if (!resp.ok) {
      showView('login');
      showError($('login-error'), resp.error);
      return;
    }
    showUpdateBanner(resp.protocol !== PROTOCOL);
    state = resp;
    if (!resp.auth.loggedIn) {
      renderLogin();
      return;
    }
    const imported = resp.pendingImport && !runActive() ? await takeImport() : null;
    renderRows();
    renderPortal();
    if (imported) noteImport(imported);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') {
      let run = false;
      if (changes.job) {
        state.job = changes.job.newValue || null;
        run = true;
      }
      if (changes.batch) {
        state.batch = changes.batch.newValue || null;
        run = true;
      }
      if (changes.logs) {
        state.logs = changes.logs.newValue || [];
        if (!$('portal-view').hidden) renderLogs();
      }
      if (run && !$('portal-view').hidden) renderRunState();
      if (changes.pendingImport && changes.pendingImport.newValue && !$('portal-view').hidden) refresh();
    } else if (area === 'local' && changes.portalSession) {
      refresh();
    }
  });

  (async function init() {
    await restoreDraft();
    await refresh();
  })();
})();
