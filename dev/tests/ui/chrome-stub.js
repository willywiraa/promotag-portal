/*
 * Minimal chrome.* stub so the real popup/history pages can be rendered outside the extension
 * for visual checks. ?view=login|setup|portal|settings|running|confirm|result|stale
 */
(function () {
  'use strict';
  const view = new URLSearchParams(location.search).get('view') || 'portal';
  const now = Date.now();
  const t = (s) => now - s * 1000;

  const item = (index, code, newDesc, status, extra) =>
    Object.assign({ index, code, newDesc, rawLine: `${code} || ${newDesc}`, status, outcome: null, oldDesc: null, message: '', jobId: null, runId: null, attempts: null, shotMissing: false }, extra);

  const batches = {
    running: {
      id: 'batch-demo', status: 'running', current: 1, confirmAll: false, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '888', '3 FOR $16.65', 'succeeded', { outcome: 'success', oldDesc: '3 FOR $15.90', attempts: 1 }),
        item(1, '889', '3 FOR $23', 'running'),
        item(2, '892', '6 FOR $29.50', 'pending'),
      ],
    },
    confirm: {
      id: 'batch-demo', status: 'running', current: 1, confirmAll: false, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '888', '3 FOR $16.65', 'succeeded', { outcome: 'success', oldDesc: '3 FOR $15.90', attempts: 1 }),
        item(1, '889', '3 FOR $23', 'awaiting_confirm'),
        item(2, '892', '6 FOR $29.50', 'pending'),
      ],
    },
    result: {
      id: 'batch-demo', status: 'done', current: 2, confirmAll: true, confirmBeforeSave: true, updatedAt: now,
      items: [
        item(0, '888', '3 FOR $16.65', 'succeeded', { outcome: 'success', oldDesc: '3 FOR $15.90', attempts: 1 }),
        item(1, '889', '3 FOR $23', 'succeeded', { outcome: 'success', oldDesc: '3 FOR $20', attempts: 2 }),
        item(2, '892', '6 FOR $29.50', 'failed', { outcome: 'failed', message: 'Tag Code 892 not found in Hybris.' }),
      ],
      teams: { status: 'sent', at: now },
    },
  };

  const jobs = {
    running: { id: 'job-2', batchId: 'batch-demo', itemIndex: 1, itemCount: 3, code: '889', newDesc: '3 FOR $23', status: 'running', stage: 'REVIEW', oldDesc: '3 FOR $20' },
    confirm: {
      id: 'job-2', batchId: 'batch-demo', itemIndex: 1, itemCount: 3, code: '889', newDesc: '3 FOR $23', status: 'awaiting_confirm', stage: 'CONFIRM', oldDesc: '3 FOR $20',
      pendingConfirm: { code: '889', oldDesc: '3 FOR $20', newDesc: '3 FOR $23', itemIndex: 1, itemCount: 3 },
    },
    result: { id: 'job-3', batchId: 'batch-demo', itemIndex: 2, itemCount: 3, code: '892', newDesc: '6 FOR $29.50', status: 'failed', stage: 'DONE' },
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

  const loggedIn = !['login', 'setup'].includes(view);
  const state = {
    ok: true,
    protocol: view === 'stale' ? undefined : 3, // "stale" = old service worker still running
    auth: loggedIn
      ? { loggedIn: true, userId: 'willy', expiresAt: now + 6 * 3600e3, setupRequired: false }
      : { loggedIn: false, setupRequired: view === 'setup' },
    settings: {
      baseUrl: 'https://backoffice.example.com/backoffice/', roleName: 'WTCSG Backoffice User Role', confirmBeforeSave: true,
      teamsWebhookUrl: 'https://default00.00.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/demo/triggers/manual/paths/invoke?api-version=1&sig=demo',
    },
    access: { hasOrigin: true, allUrls: false, teams: 'on' },
    job: jobs[view] || null,
    batch: batches[view] || null,
    logs: batches[view] ? logs : [],
    lastRunId: 'run-demo-1',
  };

  const draft = view === 'portal' || view === 'stale'
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
      getManifest: () => ({ version: '1.2.1' }),
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
  if (view === 'settings') window.addEventListener('load', () => setTimeout(() => document.getElementById('settings-btn').click(), 50));
})();
