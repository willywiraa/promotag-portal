/*
 * Minimal chrome.* stub so the real popup/history pages can be rendered outside the extension
 * for visual checks. ?view=login|setup|unconfigured|portal|settings|running|confirm|success|failure|result|stale
 * The popup preview stores the screenshots listed in window.__previewShots in the History database.
 */
(function () {
  'use strict';
  const view = new URLSearchParams(location.search).get('view') || 'portal';
  const now = Date.now();
  const t = (s) => now - s * 1000;

  const item = (index, code, newDesc, status, extra) =>
    Object.assign({ index, code, newDesc, rawLine: `${code} || ${newDesc}`, status, outcome: null, oldDesc: null, message: '', errorCode: null, jobId: null, runId: null, attempts: null, shotMissing: false }, extra);
  const verified = (code, oldDesc, newDesc, attempts) => ({
    outcome: 'success', oldDesc, attempts, runId: `run-${code}`,
    message: `Tag ${code}: "${oldDesc}" → "${newDesc}" — verified (attempt ${attempts}).`,
  });
  const notFound = (code) => ({ outcome: 'failed', errorCode: 'NOT_FOUND', runId: `run-${code}`, message: `Tag Code ${code} not found in Hybris.` });

  const batches = {
    running: {
      id: 'batch-demo', status: 'running', current: 1, confirmAll: false, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '888', '3 FOR $16.65', 'succeeded', verified('888', '3 FOR $15.90', '3 FOR $16.65', 1)),
        item(1, '889', '3 FOR $23', 'running', { runId: 'run-889' }),
        item(2, '892', '6 FOR $29.50', 'pending'),
      ],
    },
    confirm: {
      id: 'batch-demo', status: 'running', current: 1, confirmAll: false, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '888', '3 FOR $16.65', 'succeeded', verified('888', '3 FOR $15.90', '3 FOR $16.65', 1)),
        item(1, '889', '3 FOR $23', 'awaiting_confirm', { runId: 'run-889' }),
        item(2, '892', '6 FOR $29.50', 'pending'),
      ],
    },
    success: {
      id: 'batch-demo', status: 'done', current: 2, confirmAll: true, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '888', '3 FOR $16.65', 'succeeded', verified('888', '3 FOR $15.90', '3 FOR $16.65', 1)),
        item(1, '889', '3 FOR $23', 'succeeded', verified('889', '3 FOR $20', '3 FOR $23', 2)),
        item(2, '892', '6 FOR $29.50', 'unchanged', { outcome: 'already-up-to-date', oldDesc: '6 FOR $29.50', runId: 'run-892', message: 'Tag 892 already shows "6 FOR $29.50" — nothing changed.' }),
      ],
      teams: { status: 'sent', at: now },
    },
    failure: {
      id: 'batch-demo', status: 'done', current: 1, confirmAll: false, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '999', '2 FOR $82.00', 'failed', notFound('999')),
        item(1, '959', '$30 OFF $199', 'succeeded', verified('959', '2 FOR $82.00', '$30 OFF $199', 1)),
      ],
      teams: { status: 'failed', at: now, error: 'Could not reach the Teams workflow (connect ETIMEDOUT).' },
    },
    result: {
      id: 'batch-demo', status: 'done', current: 2, confirmAll: true, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '888', '3 FOR $16.65', 'succeeded', verified('888', '3 FOR $15.90', '3 FOR $16.65', 1)),
        item(1, '889', '3 FOR $23', 'succeeded', verified('889', '3 FOR $20', '3 FOR $23', 2)),
        item(2, '892', '6 FOR $29.50', 'failed', notFound('892')),
      ],
      teams: { status: 'sent', at: now },
    },
  };

  const jobs = {
    running: { id: 'job-2', runId: 'run-889', batchId: 'batch-demo', itemIndex: 1, itemCount: 3, code: '889', newDesc: '3 FOR $23', status: 'running', stage: 'REVIEW', oldDesc: '3 FOR $20' },
    confirm: {
      id: 'job-2', runId: 'run-889', batchId: 'batch-demo', itemIndex: 1, itemCount: 3, code: '889', newDesc: '3 FOR $23', status: 'awaiting_confirm', stage: 'CONFIRM', oldDesc: '3 FOR $20',
      pendingConfirm: { code: '889', oldDesc: '3 FOR $20', newDesc: '3 FOR $23', itemIndex: 1, itemCount: 3 },
    },
    success: { id: 'job-3', runId: 'run-892', batchId: 'batch-demo', itemIndex: 2, itemCount: 3, code: '892', newDesc: '6 FOR $29.50', status: 'unchanged', stage: 'DONE' },
    failure: { id: 'job-2', runId: 'run-959', batchId: 'batch-demo', itemIndex: 1, itemCount: 2, code: '959', newDesc: '$30 OFF $199', status: 'succeeded', stage: 'DONE' },
    result: { id: 'job-3', runId: 'run-892', batchId: 'batch-demo', itemIndex: 2, itemCount: 3, code: '892', newDesc: '6 FOR $29.50', status: 'failed', stage: 'DONE' },
  };

  const logs = [
    { t: t(70), level: 'info', msg: 'Run started by willy: 3 tags (888, 889, 892)' },
    { t: t(69), level: 'info', msg: '— Tag 1 of 3: 888 → "3 FOR $16.65"' },
    { t: t(60), level: 'info', msg: '[888] Current description in Hybris: "3 FOR $15.90"' },
    { t: t(52), level: 'ok', msg: '[888] Backoffice: "Item 888 saved"' },
    { t: t(47), level: 'ok', msg: '[888] Verified in the result grid: "3 FOR $16.65" (attempt 1/4).' },
    { t: t(46), level: 'ok', msg: 'Tag 888: "3 FOR $15.90" → "3 FOR $16.65" — verified (attempt 1).' },
    { t: t(45), level: 'info', msg: '— Tag 2 of 3: 889 → "3 FOR $23"' },
    { t: t(38), level: 'info', msg: '[889] Current description in Hybris: "3 FOR $20"' },
  ];
  const failureLogs = [
    { t: t(50), level: 'info', msg: 'Run started by willy: 2 tags (999, 959)' },
    { t: t(49), level: 'info', msg: '— Tag 1 of 2: 999 → "2 FOR $82.00"' },
    { t: t(41), level: 'warn', msg: '[999] No result row for Tag Code 999 (search 1 of 2).' },
    { t: t(35), level: 'error', msg: 'Tag Code 999 not found in Hybris.' },
    { t: t(34), level: 'info', msg: '— Tag 2 of 2: 959 → "$30 OFF $199"' },
    { t: t(20), level: 'ok', msg: 'Tag 959: "2 FOR $82.00" → "$30 OFF $199" — verified (attempt 1).' },
    { t: t(18), level: 'error', msg: 'Teams reply not sent: Could not reach the Teams workflow (connect ETIMEDOUT).' },
  ];

  // [runId, kind, tag code, text in the grid, highlight colour]
  const before = (code, text) => [`run-${code}`, 'before', code, text, '#F59E0B'];
  const after = (code, text) => [`run-${code}`, 'after', code, text, '#16A34A'];
  const failure = (code) => [`run-${code}`, 'failure', code, '', '#DC2626'];
  window.__previewShots = {
    running: [before('888', '3 FOR $15.90'), after('888', '3 FOR $16.65')],
    confirm: [before('888', '3 FOR $15.90'), after('888', '3 FOR $16.65'), before('889', '3 FOR $20')],
    success: [before('888', '3 FOR $15.90'), after('888', '3 FOR $16.65'), before('889', '3 FOR $20'), after('889', '3 FOR $23'), after('892', '6 FOR $29.50')],
    failure: [failure('999'), before('959', '2 FOR $82.00'), after('959', '$30 OFF $199')],
    result: [before('888', '3 FOR $15.90'), after('888', '3 FOR $16.65'), before('889', '3 FOR $20'), after('889', '3 FOR $23'), failure('892')],
  }[view] || [];

  const loggedIn = !['login', 'setup'].includes(view);
  const unconfigured = view === 'unconfigured';
  const state = {
    ok: true,
    protocol: view === 'stale' ? undefined : 3, // "stale" = old service worker still running
    auth: loggedIn
      ? { loggedIn: true, userId: 'willy', expiresAt: now + 6 * 3600e3, setupRequired: false }
      : { loggedIn: false, setupRequired: view === 'setup' },
    settings: unconfigured
      ? { baseUrl: '', roleName: '', confirmBeforeSave: true, teamsWebhookUrl: '' }
      : {
        baseUrl: 'https://backoffice.example.com/backoffice/', roleName: 'WTCSG Backoffice User Role', confirmBeforeSave: true,
        teamsWebhookUrl: 'https://default00.00.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/demo/triggers/manual/paths/invoke?api-version=1&sig=demo',
      },
    access: unconfigured ? { hasOrigin: false, allUrls: false, teams: 'off' } : { hasOrigin: true, allUrls: false, teams: 'on' },
    job: jobs[view] || null,
    batch: batches[view] || null,
    logs: view === 'failure' ? failureLogs : batches[view] ? logs : [],
    lastRunId: 'run-demo-1',
  };

  const draft = ['portal', 'stale', 'unconfigured'].includes(view)
    ? { rows: [
      { code: '888', desc: '3 FOR $16.65', line: 'Alert_Message 888 || 3 FOR $16.65' },
      { code: '889', desc: '3 FOR $23', line: 'Alert_Message 889 || 3 FOR $23' },
      { code: '892', desc: '6 FOR $29.50', line: '' },
    ] }
    : null;
  const session = { token: 'preview-token-preview-token', userId: 'willy', expiresAt: now + 3600e3 };

  const stub = {
    runtime: {
      id: 'preview',
      lastError: undefined,
      getURL: (p) => p,
      getManifest: () => ({ version: '1.3.0' }),
      reload() {},
      sendMessage(msg, cb) {
        setTimeout(() => cb && cb(msg.type === 'UI_STATE' ? state : { ok: true }), 0);
      },
    },
    storage: {
      local: { get: async () => ({ portalSession: session }), set: async () => {}, remove: async () => {} },
      session: { get: async () => (draft ? { draft } : {}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {} },
    },
    permissions: { request: async () => true },
  };
  window.chrome = Object.assign(window.chrome || {}, stub);
  if (view === 'settings') window.addEventListener('ptae-preview-ready', () => document.getElementById('settings-btn').click());
})();
