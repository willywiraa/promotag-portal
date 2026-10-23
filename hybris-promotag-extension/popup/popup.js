/* Portal UI: login view <-> execution view (one row per tag), settings, confirm gate, live log. */
(function () {
  'use strict';
  const P = globalThis.PTAE;
  const $ = (id) => document.getElementById(id);

  const STAGE_TEXT = {
    PREFLIGHT: 'checking connection',
    TAB: 'opening Backoffice',
    AWAIT_SSO: 'signing in (SSO)',
    ROLE_SUBMIT: 'selecting role',
    SHELL: 'working in Backoffice',
    REVIEW: 'reading current value',
    CONFIRM: 'waiting for you',
    SAVE: 'saving & verifying',
  };
  const CHIPS = {
    pending: ['Waiting', ''],
    running: ['Running…', 'running'],
    awaiting_confirm: ['Confirm?', 'confirm'],
    succeeded: ['✓ Verified', 'ok'],
    unchanged: ['= Already set', 'same'],
    failed: ['✗ Failed', 'fail'],
    skipped: ['Skipped', 'skip'],
    stopped: ['Stopped', 'skip'],
  };

  let state = { auth: null, settings: {}, access: {}, job: null, batch: null, logs: [], lastRunId: null };
  let rows = [blankRow()];
  let setupMode = false;
  let settingsAutoOpened = false;

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
    const until = state.auth.expiresAt ? ` · session until ${fmtTime(state.auth.expiresAt)}` : '';
    $('whoami').textContent = `Signed in as ${state.auth.userId}${until} · v${chrome.runtime.getManifest().version}`;
    renderSettings();
    renderRunState();
    renderLogs();
  }

  function toggleSettings(open) {
    const panel = $('settings-panel');
    const show = open == null ? panel.hidden : open;
    panel.hidden = !show;
    $('settings-btn').setAttribute('aria-expanded', String(show));
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

  // --- run view ------------------------------------------------------------------------------------
  function runSummary(b) {
    const s = P.batch.summary(b);
    const parts = [];
    if (s.succeeded) parts.push(`${s.succeeded} verified`);
    if (s.unchanged) parts.push(`${s.unchanged} already set`);
    if (s.failed) parts.push(`${s.failed} failed`);
    if (s.skipped + s.stopped) parts.push(`${s.skipped + s.stopped} not run`);
    return `${b.status === 'stopped' ? 'Stopped' : 'Finished'} — ${parts.join(' · ') || 'nothing done'}`;
  }

  function subLine(it, job) {
    const sub = el('div', 'run-sub');
    const quoted = (cls, text) => el('span', cls, `"${text}"`);
    if (it.status === 'succeeded' && it.oldDesc != null) {
      sub.append(quoted('old', it.oldDesc), document.createTextNode(' → '), quoted('new', it.newDesc));
      if (it.attempts > 1) sub.append(document.createTextNode(` (verified on attempt ${it.attempts})`));
    } else if (it.status === 'unchanged') {
      sub.textContent = 'Already set in Hybris — nothing changed.';
    } else if (['failed', 'skipped', 'stopped'].includes(it.status)) {
      sub.textContent = it.message || '';
      if (it.oldDesc != null && it.status === 'failed') sub.textContent += ` (current: "${it.oldDesc}")`;
    } else if (job && job.oldDesc != null) {
      sub.append(document.createTextNode('Current in Hybris: '), quoted('old', job.oldDesc));
    } else {
      return null;
    }
    return sub;
  }

  function renderRun() {
    const b = state.batch;
    $('job-form').hidden = !!b;
    $('run-view').hidden = !b;
    if (!b) return;
    const active = P.batch.isActive(b);
    const job = state.job && state.job.batchId === b.id ? state.job : null;
    $('run-title').textContent = active ? `Running ${b.items.length} tag${b.items.length > 1 ? 's' : ''}…` : runSummary(b);

    const list = $('run-rows');
    list.textContent = '';
    b.items.forEach((it, i) => {
      const current = job && job.itemIndex === i && (it.status === 'running' || it.status === 'awaiting_confirm');
      const li = el('li', ['active', 'ok', 'fail'].find((c) =>
        (c === 'active' && current) || (c === 'ok' && ['succeeded', 'unchanged'].includes(it.status)) || (c === 'fail' && it.status === 'failed')
      ) || '');
      const [label, cls] = CHIPS[it.status] || [it.status, ''];
      const chipText = current && it.status === 'running' && STAGE_TEXT[job.stage] ? `▶ ${STAGE_TEXT[job.stage]}` : label;
      li.append(el('span', 'row-num', String(i + 1)), el('span', 'run-code', it.code), el('span', 'run-desc', it.newDesc), el('span', `chip ${cls}`, chipText));
      const sub = subLine(it, current ? job : null);
      if (sub) li.append(sub);
      list.append(li);
    });

    const s = P.batch.summary(b);
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

  function renderStatus() {
    const b = state.batch;
    const job = state.job;
    const pill = $('status-text');
    if (!b) {
      pill.textContent = configured() ? 'Ready' : 'Setup needed — open Settings ⚙';
      pill.className = 'pill';
      return;
    }
    if (P.batch.isActive(b)) {
      if (job && job.status === 'awaiting_confirm') {
        pill.textContent = 'Awaiting your confirmation';
        pill.className = 'pill confirm';
      } else {
        const i = job && job.batchId === b.id ? job.itemIndex : Math.max(0, b.current);
        const stage = job && STAGE_TEXT[job.stage] ? ` – ${STAGE_TEXT[job.stage]}` : '';
        pill.textContent = b.items.length > 1 ? `Running – tag ${i + 1} of ${b.items.length}` : `Running${stage}`;
        pill.className = 'pill running';
      }
      return;
    }
    const s = P.batch.summary(b);
    if (b.status === 'stopped') {
      pill.textContent = 'Stopped';
      pill.className = 'pill';
    } else if (s.failed) {
      pill.textContent = 'Finished with errors';
      pill.className = 'pill fail';
    } else {
      pill.textContent = 'Success';
      pill.className = 'pill ok';
    }
  }

  function renderConfirm() {
    const job = state.job;
    const pc = job && job.status === 'awaiting_confirm' ? job.pendingConfirm : null;
    const panel = $('confirm-panel');
    const wasHidden = panel.hidden;
    panel.hidden = !pc;
    if (!pc) return;
    const n = pc.itemCount || 1;
    const i = pc.itemIndex || 0;
    $('cf-pos').textContent = n > 1 ? `— tag ${i + 1} of ${n}` : '';
    $('cf-code').textContent = pc.code;
    $('cf-old').textContent = pc.oldDesc === '' ? '(empty)' : pc.oldDesc;
    $('cf-new').textContent = pc.newDesc;
    const remaining = n - i;
    $('cf-all').hidden = remaining < 2;
    $('cf-all').textContent = `Confirm all (${remaining})`;
    $('cf-all').title = `Confirm this tag and the ${remaining - 1} after it without asking again`;
    $('cf-no').textContent = n > 1 ? 'Skip this tag' : 'Cancel';
    if (wasHidden) {
      panel.scrollIntoView({ block: 'nearest' });
      $('cf-yes').focus();
    }
  }

  function renderRunState() {
    renderRun();
    renderStatus();
    renderConfirm();
    $('stop-btn').hidden = !runActive();
    updateExecuteLabel();
  }

  async function answerConfirm(approve, all) {
    const job = state.job;
    if (!job) return;
    ['cf-yes', 'cf-all', 'cf-no'].forEach((id) => { $(id).disabled = true; });
    const resp = await send('UI_JOB_CONFIRM', { jobId: job.id, approve, all });
    ['cf-yes', 'cf-all', 'cf-no'].forEach((id) => { $(id).disabled = false; });
    if (!resp.ok && !handleSpecialError(resp)) showError($('job-error'), resp.error);
  }
  $('cf-yes').addEventListener('click', () => answerConfirm(true, false));
  $('cf-all').addEventListener('click', () => answerConfirm(true, true));
  $('cf-no').addEventListener('click', () => answerConfirm(false, false));

  $('stop-btn').addEventListener('click', () => send('UI_JOB_STOP'));
  $('clear-log-btn').addEventListener('click', () => send('UI_CLEAR_LOG'));
  $('history-btn').addEventListener('click', () => send('UI_OPEN_HISTORY'));
  $('rs-open').addEventListener('click', () => send('UI_OPEN_HISTORY'));

  async function newRun(nextRows) {
    const resp = await send('UI_BATCH_CLEAR');
    if (!resp.ok) {
      if (!handleSpecialError(resp)) showError($('job-error'), resp.error);
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
      .filter((it) => ['failed', 'skipped', 'stopped'].includes(it.status))
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
    showError($('job-error'), '');
    const resp = await send('UI_CAPTURE_NOW', { runId: state.lastRunId });
    if (!resp.ok) {
      if (!handleSpecialError(resp)) showError($('job-error'), resp.error);
      return;
    }
    $('rs-capture').hidden = true;
  });

  $('logout-btn').addEventListener('click', async () => {
    await send('UI_LOGOUT');
    rows = [blankRow()];
    note('');
    await refresh();
  });

  function renderLogs() {
    const list = $('log-console');
    list.textContent = '';
    const frag = document.createDocumentFragment();
    for (const entry of state.logs || []) {
      const li = el('li', entry.level || 'info');
      li.append(el('time', null, fmtTime(entry.t)), document.createTextNode(entry.msg));
      frag.append(li);
    }
    list.append(frag);
    list.scrollTop = list.scrollHeight;
  }

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
