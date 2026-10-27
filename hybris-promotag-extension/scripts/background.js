/*
 * Service worker: portal auth/session, settings + dynamic content-script registration,
 * batch/job orchestration and message routing, screenshots, history writes, watchdog and badge,
 * Teams (Daily Alert links in, run results out).
 *
 * A run is a batch of one or more tags (shared/batch.js). Tags run one at a time in the same
 * Backoffice tab; each tag is a "job" handled by the content-script engine and gets its own
 * history record. Live state lives in chrome.storage.session (survives service-worker restarts);
 * the permanent record goes to IndexedDB (shared/history-db.js).
 */
importScripts('shared/auth-crypto.js', 'shared/alert-parser.js', 'shared/batch.js', 'shared/teams.js', 'shared/history-db.js', 'auth-config.js');

const PTAE = globalThis.PTAE;
const DB = PTAE.historyDb;
const Auth = PTAE.authCrypto;
const Batch = PTAE.batch;
const Teams = PTAE.teams;

const KEYS = {
  settings: 'settings',
  session: 'portalSession',
  localCred: 'localCredential',
  lastRun: 'lastRunId',
  job: 'job',
  batch: 'batch',
  logs: 'logs',
  draft: 'draft',
  pendingImport: 'pendingImport',
};
const MAIN_WORLD_FILES = ['scripts/zk-bridge.js'];
const ISOLATED_FILES = ['scripts/zk-dom.js', 'scripts/selectors.js', 'scripts/content.js'];
const SCRIPT_IDS = ['ptae-bridge', 'ptae-content'];
const LOG_CAP = 500;
const DEFAULT_SETTINGS = { baseUrl: '', roleName: 'WTCSG Backoffice User Role', confirmBeforeSave: true, teamsWebhookUrl: '', teamsScreenshots: true };
const ACTIVE = new Set(['starting', 'running', 'awaiting_confirm']);
const WATCHDOG = { alarm: 'ptae-watchdog', ssoMs: 180000, heartbeatMs: 90000, confirmMs: 660000, idleBatchMs: 60000 };
const MSG_NETWORK = 'Network Error: Verify GlobalProtect VPN connection.';
// Bumped whenever popup <-> service-worker messages change; the popup offers a reload on mismatch
// (unpacked extensions load new popup files immediately, but keep the old worker until reloaded).
const PROTOCOL = 3;

class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'USER';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- storage helpers -------------------------------------------------------------------------------
async function getLocal(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] === undefined ? fallback : o[key];
}

async function getSession(key, fallback) {
  const o = await chrome.storage.session.get(key);
  return o[key] === undefined || o[key] === null ? fallback : o[key];
}

let chain = Promise.resolve();
/** Serializes read-modify-write sections on session storage. Never nest serialize() calls. */
function serialize(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function currentJob() {
  return getSession(KEYS.job, null);
}

function getBatch() {
  return getSession(KEYS.batch, null);
}

function updateJob(patch) {
  return serialize(async () => {
    const job = await getSession(KEYS.job, null);
    if (!job) return null;
    const next = Object.assign({}, job, patch, { updatedAt: Date.now() });
    await chrome.storage.session.set({ [KEYS.job]: next });
    return next;
  });
}

/** fn(batch) must return the new batch (Batch.* helpers return copies). */
function updateBatch(fn) {
  return serialize(async () => {
    const batch = await getSession(KEYS.batch, null);
    if (!batch) return null;
    const next = fn(batch) || batch;
    await chrome.storage.session.set({ [KEYS.batch]: next });
    return next;
  });
}

async function appendLog(level, msg, runId) {
  const entry = { t: Date.now(), level: level || 'info', msg: String(msg) };
  await serialize(async () => {
    const logs = await getSession(KEYS.logs, []);
    logs.push(entry);
    if (logs.length > LOG_CAP) logs.splice(0, logs.length - LOG_CAP);
    await chrome.storage.session.set({ [KEYS.logs]: logs });
  });
  if (runId) await DB.appendLog(runId, entry).catch(() => {});
}

// --- settings & content-script registration -------------------------------------------------------
async function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, await getLocal(KEYS.settings, {}));
}

/** https://host/backoffice/login.zul -> origin, base URL (/backoffice/), match pattern, permission pattern. */
function deriveTarget(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch (_) {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const segment = u.pathname.split('/').filter(Boolean)[0] || 'backoffice';
  const basePath = `/${segment}/`;
  return {
    origin: u.origin,
    baseUrl: u.origin + basePath,
    match: `${u.origin}${basePath}*`,
    permission: `${u.origin}/*`,
  };
}

let syncChain = Promise.resolve();
function syncContentScripts() {
  syncChain = syncChain.then(doSync, doSync);
  return syncChain;
}

async function doSync() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ours = existing.filter((s) => SCRIPT_IDS.includes(s.id)).map((s) => s.id);
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
    const settings = await getSettings();
    const t = settings.baseUrl && deriveTarget(settings.baseUrl);
    if (!t) return { registered: false, reason: 'no-url' };
    if (!(await chrome.permissions.contains({ origins: [t.permission] }))) return { registered: false, reason: 'no-permission' };
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_IDS[0], matches: [t.match], js: MAIN_WORLD_FILES, runAt: 'document_idle', world: 'MAIN', persistAcrossSessions: true },
      { id: SCRIPT_IDS[1], matches: [t.match], js: ISOLATED_FILES, runAt: 'document_idle', persistAcrossSessions: true },
    ]);
    return { registered: true };
  } catch (err) {
    console.warn('Content script registration failed', err);
    return { registered: false, reason: String(err && err.message) };
  }
}

async function accessState(settings) {
  const t = settings.baseUrl && deriveTarget(settings.baseUrl);
  const hook = Teams.parseWebhookUrl(settings.teamsWebhookUrl);
  const [hasOrigin, allUrls, hasHook] = await Promise.all([
    t ? chrome.permissions.contains({ origins: [t.permission] }) : Promise.resolve(false),
    chrome.permissions.contains({ origins: ['<all_urls>'] }),
    hook ? chrome.permissions.contains({ origins: [hook.permission] }) : Promise.resolve(false),
  ]);
  return { hasOrigin, allUrls, teams: !hook ? 'off' : hasHook ? 'on' : 'no-access' };
}

async function saveSettings(input) {
  const next = await getSettings();
  if ('baseUrl' in input) {
    if (input.baseUrl) {
      const t = deriveTarget(input.baseUrl);
      if (!t) throw new UserError('Enter a valid http(s) Backoffice URL, e.g. https://backoffice.example.com/backoffice/');
      next.baseUrl = t.baseUrl;
    } else {
      next.baseUrl = '';
    }
  }
  if ('roleName' in input) next.roleName = String(input.roleName || '').trim() || DEFAULT_SETTINGS.roleName;
  if ('confirmBeforeSave' in input) next.confirmBeforeSave = !!input.confirmBeforeSave;
  if ('teamsScreenshots' in input) next.teamsScreenshots = !!input.teamsScreenshots;
  if ('teamsWebhookUrl' in input) {
    const raw = String(input.teamsWebhookUrl || '').trim();
    if (raw && !Teams.parseWebhookUrl(raw)) throw new UserError("Paste the HTTP URL from your flow's trigger (it starts with https://), not a Teams link.");
    next.teamsWebhookUrl = raw;
  }
  await chrome.storage.local.set({ [KEYS.settings]: next });
  const registration = await syncContentScripts();
  return { ok: true, settings: next, registration, access: await accessState(next) };
}

// --- portal auth ----------------------------------------------------------------------------------
function configuredUsers() {
  return ((PTAE.AUTH_CONFIG && PTAE.AUTH_CONFIG.users) || []).filter((u) => u && u.userId && u.hash && u.salt);
}

async function authStatus() {
  const session = await getLocal(KEYS.session, null);
  const localCred = await getLocal(KEYS.localCred, null);
  const loggedIn = Auth.isSessionValid(session);
  return {
    loggedIn,
    userId: loggedIn ? session.userId : null,
    expiresAt: loggedIn ? session.expiresAt : null,
    setupRequired: !configuredUsers().length && !localCred,
  };
}

async function login(userId, password) {
  const records = configuredUsers();
  const localCred = await getLocal(KEYS.localCred, null);
  if (localCred) records.push(localCred);
  if (!records.length) return { ok: false, error: 'No portal login exists yet — create one first.' };
  const record = await Auth.findAndVerify(records, userId, password);
  if (!record) {
    await sleep(400);
    return { ok: false, error: 'Invalid User ID or password.' };
  }
  const ttl = (PTAE.AUTH_CONFIG && PTAE.AUTH_CONFIG.sessionTtlMinutes) || 480;
  await chrome.storage.local.set({ [KEYS.session]: Auth.createSession(record.userId, ttl) });
  return { ok: true, userId: record.userId };
}

async function setup(userId, password) {
  const status = await authStatus();
  if (!status.setupRequired) return { ok: false, error: 'A portal login already exists — please log in.' };
  const id = String(userId || '').trim();
  if (id.length < 3) return { ok: false, error: 'User ID must be at least 3 characters.' };
  if (String(password || '').length < 8) return { ok: false, error: 'Password / Access Key must be at least 8 characters.' };
  await chrome.storage.local.set({ [KEYS.localCred]: await Auth.hashCredential(id, password) });
  return login(id, password);
}

async function requireSession() {
  const session = await getLocal(KEYS.session, null);
  if (!Auth.isSessionValid(session)) throw new UserError('Portal session expired — please log in again.', 'AUTH');
  return session;
}

async function logout() {
  await stopBatch('Stopped: operator logged out.');
  await chrome.storage.local.remove(KEYS.session);
  await chrome.storage.session.remove([KEYS.draft, KEYS.logs, KEYS.job, KEYS.batch, KEYS.pendingImport]);
  setBadge('clear');
}

// --- badge ------------------------------------------------------------------------------------------
function setBadge(state) {
  const map = {
    running: ['…', '#0066FF'],
    confirm: ['?', '#F59E0B'],
    succeeded: ['✓', '#16A34A'],
    failed: ['!', '#DC2626'],
    import: ['NEW', '#0066FF'],
  };
  const [text, color] = map[state] || ['', '#0066FF'];
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
}

// --- batches ----------------------------------------------------------------------------------------
/** Starts a run of one or more tags: msg.items = [{code, newDesc, rawLine}]. */
async function startBatch(msg) {
  const session = await requireSession();
  const { items, errors } = Batch.normalizeItems(msg.items, PTAE.parser);
  if (errors.length) throw new UserError(errors[0]);
  if (!items.length) throw new UserError('Add at least one Tag Code with its new description.');

  const settings = await getSettings();
  const t = settings.baseUrl && deriveTarget(settings.baseUrl);
  if (!t) throw new UserError('Set the Backoffice URL in Settings (⚙) first.');
  if (!(await chrome.permissions.contains({ origins: [t.permission] }))) {
    throw new UserError('Grant access to the Backoffice URL in Settings (⚙) first.');
  }
  const [job, existing] = await Promise.all([currentJob(), getBatch()]);
  if ((job && ACTIVE.has(job.status)) || Batch.isActive(existing)) throw new UserError('A run is already in progress.');

  const batch = Object.assign(
    Batch.createBatch({ id: DB.newId('batch'), items, operator: session.userId, confirmBeforeSave: settings.confirmBeforeSave }),
    { origin: t.origin, baseUrl: t.baseUrl, roleName: settings.roleName, tabId: null }
  );
  await chrome.storage.session.set({ [KEYS.batch]: batch, [KEYS.logs]: [] });
  await chrome.storage.session.remove(KEYS.job);
  setBadge('running');
  await chrome.alarms.create(WATCHDOG.alarm, { periodInMinutes: 0.5 });
  const list = items.map((it) => it.code).join(', ');
  await appendLog('info', `Run started by ${session.userId}: ${items.length} tag${items.length > 1 ? 's' : ''} (${list})`);

  runNextItem(batch.id).catch((err) => stopBatch(`Could not start: ${err.message}`));
  return { ok: true, batchId: batch.id };
}

/** Creates the job for the next pending tag and hands it to the content script. */
async function runNextItem(batchId) {
  const batch = await getBatch();
  if (!batch || batch.id !== batchId || batch.status !== 'running') return;
  const index = Batch.nextIndex(batch);
  if (index < 0) return completeBatch();
  const item = batch.items[index];
  const now = Date.now();
  const job = {
    id: DB.newId('job'),
    runId: DB.newId('run'),
    batchId: batch.id,
    itemIndex: index,
    itemCount: batch.items.length,
    tabId: batch.tabId,
    origin: batch.origin,
    baseUrl: batch.baseUrl,
    code: item.code,
    newDesc: item.newDesc,
    rawAlert: item.rawLine,
    roleName: batch.roleName,
    confirmBeforeSave: batch.confirmBeforeSave && !batch.confirmAll,
    operator: batch.operator,
    status: 'starting',
    stage: batch.tabId == null ? 'PREFLIGHT' : 'TAB',
    oldDesc: null,
    descColumn: -1,
    ssoAttempts: 0,
    reachedShell: false,
    pendingConfirm: null,
    shotMissing: false,
    result: null,
    startedAt: now,
    updatedAt: now,
    lastHeartbeat: now,
  };
  await updateBatch((b) => Batch.startItem(b, index, { jobId: job.id, runId: job.runId }));
  await chrome.storage.session.set({ [KEYS.job]: job });
  await chrome.storage.local.set({ [KEYS.lastRun]: job.runId });
  await DB.createRun({
    id: job.runId,
    startedAt: now,
    operator: job.operator,
    backofficeUrl: job.baseUrl,
    rawAlert: job.rawAlert,
    tagCode: job.code,
    oldDesc: null,
    newDesc: job.newDesc,
    batchId: batch.id,
    batchIndex: index,
    batchSize: batch.items.length,
  });
  const pos = batch.items.length > 1 ? `Tag ${index + 1} of ${batch.items.length}: ` : '';
  await appendLog('info', `— ${pos}${job.code} → "${job.newDesc}"`, job.runId);

  launchJob(job).catch((err) =>
    finishJob({ outcome: 'failed', code: err.code || 'ERROR', message: err.message || String(err) })
  );
}

async function launchJob(job) {
  let tabId = job.tabId;
  let created = false;
  if (tabId == null) {
    await appendLog('info', 'Checking the connection to Backoffice…', job.runId);
    try {
      await fetch(job.baseUrl, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch (_) {
      throw new UserError(MSG_NETWORK, 'NETWORK'); // DNS/connect failure or timeout: VPN is down
    }
    const picked = await pickTab(job);
    tabId = picked.tab.id;
    created = picked.created;
    await updateBatch((b) => Object.assign(b, { tabId }));
    await appendLog('info', created ? 'Opened a new Backoffice tab.' : `Using the open Backoffice tab (#${tabId}).`, job.runId);
  } else {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      /* closed */
    }
    if (!tab || !tab.url || !tab.url.startsWith(job.origin + '/')) {
      throw new UserError('The Backoffice tab was closed or left Backoffice — the run was stopped.', 'TAB_CLOSED');
    }
  }
  const fresh = await updateJob({ tabId, status: 'running', stage: 'TAB' });
  if (!created) {
    if (await ensureContentScript(tabId)) await sendToTab(tabId, { type: 'BG_RUN', job: fresh });
    return;
  }
  // New tab: the registered content script normally announces itself (CS_READY). Also poll, in
  // case it loaded before the tab id was recorded; the runner ignores a duplicate start.
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const job2 = await currentJob();
    if (!job2 || job2.id !== job.id || !ACTIVE.has(job2.status) || job2.stage !== 'TAB') return;
    const ping = await sendToTab(tabId, { type: 'BG_PING' });
    if (ping && ping.ok) {
      await sendToTab(tabId, { type: 'BG_RUN', job: job2 });
      return;
    }
  }
}

async function pickTab(job) {
  const tabs = await chrome.tabs.query({});
  const inApp = tabs.filter((t) => t.url && t.url.startsWith(job.baseUrl));
  const onHost = tabs.filter((t) => t.url && t.url.startsWith(job.origin + '/'));
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const isActive = (t) => activeTab && t.id === activeTab.id;
  // Prefer the tab the operator is looking at, and Backoffice pages over other pages on the host.
  const tab = inApp.find(isActive) || inApp[0] || onHost.find(isActive) || onHost[0];
  if (tab) {
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    return { tab, created: false };
  }
  return { tab: await chrome.tabs.create({ url: job.baseUrl, active: true }), created: true };
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    return null;
  }
}

async function ensureContentScript(tabId) {
  const ping = await sendToTab(tabId, { type: 'BG_PING' });
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: MAIN_WORLD_FILES, world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ISOLATED_FILES });
  } catch (err) {
    await appendLog('warn', `Waiting for the Backoffice page to load (${err.message}).`, (await currentJob() || {}).runId);
    return false;
  }
  return true; // the injected script also sends CS_READY; duplicate starts are ignored by job id
}

const STAGE_FIELDS = ['ssoAttempts', 'reachedShell', 'oldDesc', 'descColumn'];
const finishing = new Set(); // job ids being finalised (result, tab close and watchdog can race)

/** Records a tag's result, then starts the next tag or completes the run. */
async function finishJob(result) {
  const job = await currentJob();
  if (!job || !ACTIVE.has(job.status) || finishing.has(job.id)) return;
  finishing.add(job.id);
  try {
    await finalize(job, result);
  } finally {
    finishing.delete(job.id);
  }
}

async function finalize(job, result) {
  const outcome = result.outcome || 'failed';
  const status =
    outcome === 'success' || outcome === 'already-up-to-date' ? 'succeeded' :
    outcome === 'cancelled' ? 'cancelled' :
    outcome === 'aborted' ? 'aborted' : 'failed';
  const oldDesc = result.oldDesc != null ? result.oldDesc : job.oldDesc;
  const finishedAt = Date.now();
  await updateJob({ status, stage: 'DONE', pendingConfirm: null, finishedAt, result: Object.assign({}, result, { oldDesc }) });
  const level = status === 'succeeded' ? 'ok' : status === 'failed' ? 'error' : 'warn';
  await appendLog(level, result.message || outcome, job.runId);
  await DB.updateRun(job.runId, {
    finishedAt,
    outcome,
    message: result.message || '',
    oldDesc,
    verify: result.verify || null,
  }).catch(() => {});

  let action = 'done';
  await updateBatch((b) => {
    if (b.id !== job.batchId) return b;
    const r = Batch.applyResult(b, job.itemIndex, Object.assign({}, result, { oldDesc, shotMissing: !!job.shotMissing }), finishedAt);
    action = r.action;
    return r.batch;
  });
  if (action === 'next') {
    setBadge('running');
    runNextItem(job.batchId).catch((err) => stopBatch(`Stopped: ${err.message}`));
    return;
  }
  await completeBatch();
}

async function completeBatch() {
  const batch = await getBatch();
  await chrome.alarms.clear(WATCHDOG.alarm);
  if (!batch) return;
  const s = Batch.summary(batch);
  if (s.total > 1) {
    const notRun = s.skipped + s.stopped;
    const text = `Run finished — ${s.total} tags: ${s.succeeded} verified, ${s.unchanged} already set, ${s.failed} failed${notRun ? `, ${notRun} not run` : ''}.`;
    await appendLog(s.failed ? 'error' : notRun ? 'warn' : 'ok', text);
  }
  setBadge(s.failed ? 'failed' : s.succeeded + s.unchanged === s.total ? 'succeeded' : 'clear');
  postToTeams(batch.id).catch(() => {});
}

/** Stops the whole run: the current tag is aborted (unsaved edits are reverted), the rest are skipped. */
async function stopBatch(reason) {
  const batch = await getBatch();
  if (!Batch.isActive(batch)) return;
  await updateBatch((b) => Batch.requestStop(b));
  const job = await currentJob();
  if (job && ACTIVE.has(job.status) && job.batchId === batch.id) {
    if (job.tabId != null) await sendToTab(job.tabId, { type: 'BG_ABORT', jobId: job.id, reason });
    await finishJob({ outcome: 'aborted', code: 'ABORTED', message: reason });
  } else {
    await updateBatch((b) => Batch.finalizeStop(b, reason));
    await appendLog('warn', reason);
    await completeBatch();
  }
}

async function confirmJob(jobId, approve, all) {
  const job = await currentJob();
  if (!job || job.id !== jobId || job.status !== 'awaiting_confirm') throw new UserError('Nothing is waiting for confirmation.');
  await updateJob({ status: 'running', pendingConfirm: null, lastHeartbeat: Date.now() });
  await updateBatch((b) => {
    const next = Batch.markItem(b, job.itemIndex, 'running');
    if (approve && all) next.confirmAll = true;
    return next;
  });
  setBadge('running');
  const note = !approve ? 'Operator skipped this tag.' : all ? 'Operator confirmed this and all remaining tags.' : 'Operator confirmed the change.';
  await appendLog(approve ? 'ok' : 'warn', note, job.runId);
  const ack = await sendToTab(job.tabId, { type: 'BG_CONFIRM', jobId, approve });
  if (!ack) {
    await finishJob({ outcome: 'failed', code: 'TAB', message: 'Lost contact with the Backoffice tab — no changes made.' });
    throw new UserError('Lost contact with the Backoffice tab.');
  }
  return { ok: true };
}

// --- screenshots ------------------------------------------------------------------------------------
// JPEG: small enough to go into the Teams replies, and the browser (or Edge on the VM) encodes it, so
// no canvas is needed.
const SHOT_QUALITY = 85;

async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(400);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: SHOT_QUALITY });
  const blob = await (await fetch(dataUrl)).blob();
  const size = Teams.imageSize(new Uint8Array(await blob.arrayBuffer())) || { width: 0, height: 0 };
  return { blob, mime: blob.type || 'image/jpeg', width: size.width, height: size.height, bytes: blob.size };
}

function captureErrorText(err) {
  const text = String((err && err.message) || err);
  if (/activeTab|all_urls|permission/i.test(text)) {
    return 'The browser blocked the capture. Open the portal from the Backoffice tab, or enable "Always allow screenshots" in Settings.';
  }
  return text;
}

async function captureForJob(job, kind) {
  try {
    const shot = await captureTab(job.tabId);
    const id = await DB.addScreenshot(Object.assign({ runId: job.runId, kind }, shot));
    return { ok: true, id };
  } catch (err) {
    await updateJob({ shotMissing: true });
    return { ok: false, error: captureErrorText(err) };
  }
}

async function captureNow(runId) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const settings = await getSettings();
  const t = settings.baseUrl && deriveTarget(settings.baseUrl);
  if (!tab || !t || !tab.url || !tab.url.startsWith(t.origin + '/')) {
    throw new UserError('Switch to the Backoffice tab, open the portal there, then click Capture now.');
  }
  const rid = runId || (await getLocal(KEYS.lastRun, null));
  if (!rid) throw new UserError('No run to attach the screenshot to.');
  try {
    const shot = await captureTab(tab.id);
    const id = await DB.addScreenshot(Object.assign({ runId: rid, kind: 'manual' }, shot));
    await DB.appendLog(rid, { t: Date.now(), level: 'info', msg: 'Manual screenshot captured.' }).catch(() => {});
    return { ok: true, id };
  } catch (err) {
    throw new UserError(captureErrorText(err));
  }
}

// --- Teams reply ------------------------------------------------------------------------------------
// When a run finishes, the user's Power Automate flow is called once per tag that reached Hybris and
// replies with that tag's line under its own Daily Alert post (see TEAMS-SETUP.md). The flow's URL is
// in Settings; screenshots stay in History.
const teamsPosting = new Set(); // batch ids being posted (completion and retry can race)
const TEAMS_GAP_MS = 400; // between two calls, so a long run doesn't arrive as one burst

/** The flow's URL, once access to it is granted. */
async function teamsWebhook() {
  const hook = Teams.parseWebhookUrl((await getSettings()).teamsWebhookUrl);
  if (!hook) throw new UserError('Set the Teams workflow URL in Settings (⚙) first.');
  if (!(await chrome.permissions.contains({ origins: [hook.permission] }))) {
    throw new UserError('Grant access to the Teams workflow URL in Settings (⚙) first.');
  }
  return hook;
}

async function postToWebhook(url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
  } catch (_) {
    throw new UserError('Could not reach the Teams workflow — check your internet connection.');
  }
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new UserError('The workflow refused the request — set its trigger to "Who can trigger the flow: Anyone".');
  }
  if (res.status === 404) throw new UserError("Workflow not found — copy the HTTP URL again from the flow's trigger.");
  throw new UserError(`The Teams workflow answered HTTP ${res.status}.`);
}

/**
 * The screenshot of the updated tag for its reply, from the tag's own run: the latest "after" shot
 * (for a failed tag the failure shot, or one taken with Capture now). Null when there is none.
 */
async function tagImage(item) {
  if (!item.runId) return null;
  try {
    const shots = await DB.getScreenshotsForRun(item.runId);
    const latest = (kind) => shots.filter((s) => s.kind === kind).pop();
    const shot = latest('after') || latest('failure') || latest('manual');
    const rec = shot && (await DB.getScreenshot(shot.id));
    if (!rec || !rec.blob) return null;
    return { bytes: new Uint8Array(await rec.blob.arrayBuffer()), contentType: rec.mime || rec.blob.type };
  } catch (_) {
    return null;
  }
}

/** The newest screenshot in History, for the test reply. */
async function latestImage() {
  const { items } = await DB.listRuns({ limit: 20 }).catch(() => ({ items: [] }));
  for (const run of items) {
    const image = await tagImage({ runId: run.id });
    if (image) return image;
  }
  return null;
}

/**
 * Replies under each tag's Daily Alert, one call per tag with its screenshot, and records which tags
 * are done. The first failure stops the rest (a wrong URL or no internet fails them all); retry sends
 * the ones not sent.
 */
async function postToTeams(batchId, retry) {
  const [settings, batch] = await Promise.all([getSettings(), getBatch()]);
  if (!settings.teamsWebhookUrl || !batch || batch.id !== batchId || Batch.isActive(batch)) return;
  if (!Teams.shouldPost(batch) || (batch.teams && !retry) || teamsPosting.has(batchId)) return;
  teamsPosting.add(batchId);
  const sent = (batch.teams && batch.teams.sent) || [];
  const todo = batch.items.filter((it) => Teams.isReported(it) && !sent.includes(it.code));
  const pending = () => todo.map((it) => it.code).filter((code) => !sent.includes(code));
  const setTeams = (status, error) => updateBatch((b) => (b.id === batchId
    ? Object.assign(b, { teams: { status, at: Date.now(), error: error || null, sent: sent.slice(), pending: pending() } })
    : b));
  try {
    await setTeams('sending');
    const hook = await teamsWebhook();
    for (const [i, it] of todo.entries()) {
      if (i) await sleep(TEAMS_GAP_MS);
      const image = settings.teamsScreenshots !== false ? await tagImage(it) : undefined;
      await postToWebhook(hook.url, Teams.buildPayload(it, image, batch));
      sent.push(it.code);
      await setTeams('sending');
    }
    await setTeams('sent');
    await appendLog('ok', `Results sent to Teams: a reply under the Daily Alert of ${sent.join(', ')}.`);
  } catch (err) {
    const error = (err && err.message) || String(err);
    await setTeams('failed', error);
    await appendLog('warn', `Teams reply not sent for ${pending().join(', ')}: ${error}`);
  } finally {
    teamsPosting.delete(batchId);
  }
}

async function retryTeams() {
  const batch = await getBatch();
  if (!batch || Batch.isActive(batch)) throw new UserError('There is no finished run to send.');
  await postToTeams(batch.id, true);
  const after = await getBatch();
  if (after && after.teams && after.teams.status === 'failed') throw new UserError(after.teams.error);
  return { ok: true };
}

/** Posts a short test reply under the latest Daily Alert, with the newest screenshot if there is one. */
async function sendTeamsTest() {
  const session = await requireSession();
  const hook = await teamsWebhook();
  const image = (await getSettings()).teamsScreenshots !== false ? await latestImage() : null;
  const payload = Teams.buildTestPayload({ operator: session.userId, image });
  await postToWebhook(hook.url, payload);
  return { ok: true, withScreenshot: !!payload.message.hostedContents };
}

// --- "Open in Promo Tag Portal" links -----------------------------------------------------------------
// The button on the Daily Alert card opens <Backoffice URL>#promotags=<"code || description" lines>.
// The tags are kept for the popup, removed from the address bar, and the popup opens to review them.
const IMPORT_TTL_MS = 3600000;
let lastImport = { tabId: null, url: '', at: 0 };

async function checkImportLink(tabId, url) {
  const link = Teams.parseImportLink(url);
  if (!link) return;
  // A click reports the same URL twice (tab created, then navigated).
  if (lastImport.tabId === tabId && lastImport.url === url && Date.now() - lastImport.at < 10000) return;
  const t = deriveTarget((await getSettings()).baseUrl);
  if (!t || !url.startsWith(t.origin + '/')) return;
  lastImport = { tabId, url, at: Date.now() };
  const parsed = PTAE.parser.parseAlerts(link.text);
  await chrome.storage.session.set({
    [KEYS.pendingImport]: { items: parsed.items, errors: parsed.errors, warnings: parsed.warnings, at: Date.now() },
  });
  chrome.tabs.update(tabId, { url: link.cleanUrl }).catch(() => {}); // a reload must not import again
  if (!Batch.isActive(await getBatch())) setBadge('import');
  try {
    if (chrome.action.openPopup) await chrome.action.openPopup();
  } catch (_) {
    /* not supported or no focused window: the badge shows NEW instead */
  }
}

async function pendingImport() {
  const pending = await getSession(KEYS.pendingImport, null);
  return pending && Date.now() - pending.at < IMPORT_TTL_MS ? pending : null;
}

async function takeImport() {
  const pending = await pendingImport();
  await chrome.storage.session.remove(KEYS.pendingImport);
  return pending;
}

// --- messages from the content script ---------------------------------------------------------------
function senderOrigin(sender) {
  try {
    return new URL(sender.url || (sender.tab && sender.tab.url) || '').origin;
  } catch (_) {
    return '';
  }
}

async function handleContent(msg, sender) {
  const job = await currentJob();
  const tabId = sender.tab && sender.tab.id;
  const fromJobTab = !!job && ACTIVE.has(job.status) && tabId === job.tabId && senderOrigin(sender) === job.origin;

  if (msg.type === 'CS_READY') {
    if (!fromJobTab || job.status === 'starting') return { job: null };
    return { job: await updateJob({ lastHeartbeat: Date.now() }) };
  }
  if (!fromJobTab || msg.jobId !== job.id) return { ok: false, error: 'stale job' };
  await updateJob({ lastHeartbeat: Date.now() });

  switch (msg.type) {
    case 'CS_HEARTBEAT':
      return { ok: true };
    case 'CS_LOG': {
      const prefix = job.itemCount > 1 ? `[${job.code}] ` : '';
      await appendLog(msg.level, prefix + msg.msg, job.runId);
      return { ok: true };
    }
    case 'CS_STAGE': {
      const patch = { stage: String(msg.stage || job.stage) };
      const data = msg.data || {};
      STAGE_FIELDS.forEach((k) => {
        if (k in data) patch[k] = data[k];
      });
      await updateJob(patch);
      if ('oldDesc' in data) await DB.updateRun(job.runId, { oldDesc: data.oldDesc }).catch(() => {});
      return { ok: true };
    }
    case 'CS_AWAIT_CONFIRM':
      await updateJob({
        status: 'awaiting_confirm',
        stage: 'CONFIRM',
        pendingConfirm: {
          code: msg.code,
          oldDesc: msg.oldDesc,
          newDesc: msg.newDesc,
          itemIndex: job.itemIndex,
          itemCount: job.itemCount,
          at: Date.now(),
        },
      });
      await updateBatch((b) => (b.id === job.batchId ? Batch.markItem(b, job.itemIndex, 'awaiting_confirm') : b));
      setBadge('confirm');
      try {
        if (chrome.action.openPopup) await chrome.action.openPopup();
      } catch (_) {
        /* not supported or no focused window: the badge shows "?" instead */
      }
      return { ok: true };
    case 'CS_CAPTURE':
      return captureForJob(job, String(msg.kind || 'manual'));
    case 'CS_RESULT':
      await finishJob(msg.result || { outcome: 'failed', message: 'No result.' });
      return { ok: true };
    default:
      return { ok: false, error: 'unknown message' };
  }
}

// --- messages from the popup / history page ---------------------------------------------------------
function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

async function uiState() {
  const [auth, settings, job, batch, logs, lastRunId, imported] = await Promise.all([
    authStatus(),
    getSettings(),
    currentJob(),
    getBatch(),
    getSession(KEYS.logs, []),
    getLocal(KEYS.lastRun, null),
    pendingImport(),
  ]);
  if (!Batch.isActive(batch)) setBadge('clear');
  return { ok: true, protocol: PROTOCOL, auth, settings, access: await accessState(settings), job, batch, logs, lastRunId, pendingImport: imported };
}

async function handleUi(msg, sender) {
  if (!isExtensionPage(sender)) throw new UserError('Unauthorized sender.');
  switch (msg.type) {
    case 'UI_STATE':
      return uiState();
    case 'UI_LOGIN':
      return login(msg.userId, msg.password);
    case 'UI_SETUP':
      return setup(msg.userId, msg.password);
    case 'UI_LOGOUT':
      await logout();
      return { ok: true };
    case 'UI_SETTINGS_SAVE':
      await requireSession();
      return saveSettings(msg.settings || {});
    case 'UI_BATCH_START':
      return startBatch(msg);
    case 'UI_JOB_START': // single tag (older popup)
      return startBatch({ items: [{ code: msg.code, newDesc: msg.newDesc, rawLine: msg.rawAlert }] });
    case 'UI_JOB_STOP':
      await requireSession();
      await stopBatch('Stopped by operator.');
      return { ok: true };
    case 'UI_JOB_CONFIRM':
      await requireSession();
      return confirmJob(msg.jobId, !!msg.approve, !!msg.all);
    case 'UI_CAPTURE_NOW':
      await requireSession();
      return captureNow(msg.runId);
    case 'UI_OPEN_HISTORY': {
      const hash = msg.runId ? `#run=${encodeURIComponent(msg.runId)}` : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') + hash });
      return { ok: true };
    }
    case 'UI_CLEAR_LOG':
      await chrome.storage.session.remove(KEYS.logs);
      return { ok: true };
    case 'UI_BATCH_CLEAR': {
      if (Batch.isActive(await getBatch())) throw new UserError('A run is still in progress.');
      await chrome.storage.session.remove([KEYS.batch, KEYS.job, KEYS.logs]);
      setBadge('clear');
      return { ok: true };
    }
    case 'UI_IMPORT_TAKE':
      await requireSession();
      return { ok: true, import: await takeImport() };
    case 'UI_TEAMS_TEST':
      return sendTeamsTest();
    case 'UI_TEAMS_RETRY':
      await requireSession();
      return retryTeams();
    default:
      throw new UserError(`Unknown request ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  let handler = null;
  if (msg.type.startsWith('CS_') && sender.tab) handler = handleContent;
  else if (msg.type.startsWith('UI_')) handler = handleUi;
  if (!handler) return false;
  handler(msg, sender).then(
    (res) => sendResponse(res === undefined ? { ok: true } : res),
    (err) => sendResponse({ ok: false, error: (err && err.message) || String(err), code: err && err.code })
  );
  return true; // async response
});

// --- watchdog & tab events --------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG.alarm) return;
  const [job, batch] = await Promise.all([currentJob(), getBatch()]);
  if (!job || !ACTIVE.has(job.status)) {
    // Between two tags nothing reports progress; recover if the hand-over got lost.
    if (Batch.isActive(batch) && Date.now() - (batch.updatedAt || 0) > WATCHDOG.idleBatchMs) {
      await stopBatch('Stopped: the run made no progress.');
    } else if (!Batch.isActive(batch)) {
      await chrome.alarms.clear(WATCHDOG.alarm);
    }
    return;
  }
  const idle = Date.now() - (job.lastHeartbeat || job.updatedAt);
  const waitingOutside = ['PREFLIGHT', 'TAB', 'AWAIT_SSO', 'ROLE_SUBMIT'].includes(job.stage);
  const limit = job.status === 'awaiting_confirm' ? WATCHDOG.confirmMs : waitingOutside ? WATCHDOG.ssoMs : WATCHDOG.heartbeatMs;
  if (idle <= limit) return;
  let message = 'The Backoffice tab stopped responding — check the tab and your GlobalProtect VPN connection, then retry.';
  if (job.stage === 'AWAIT_SSO') message = 'Single Sign On did not complete in time — finish signing in to Backoffice, then retry.';
  if (job.status === 'awaiting_confirm') message = 'Confirmation timed out — no changes made.';
  if (job.tabId != null) await sendToTab(job.tabId, { type: 'BG_ABORT', jobId: job.id, reason: message });
  await finishJob({ outcome: job.status === 'awaiting_confirm' ? 'cancelled' : 'failed', code: 'STALLED', message });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await currentJob();
  if (job && ACTIVE.has(job.status) && job.tabId === tabId) {
    await finishJob({ outcome: 'failed', code: 'TAB_CLOSED', message: 'The Backoffice tab was closed — the run was stopped.' });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  checkImportLink(tab.id, tab.pendingUrl || tab.url).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) checkImportLink(tabId, info.url).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'loading') return;
  const job = await currentJob();
  if (!job || !ACTIVE.has(job.status) || job.tabId !== tabId) return;
  const url = tab.url || info.url || '';
  // Without host permission the URL is hidden: the tab is outside Backoffice (SSO identity provider).
  if (!url.startsWith(job.origin + '/') && !job.idpNotified) {
    await updateJob({ idpNotified: true, lastHeartbeat: Date.now() });
    await appendLog('info', 'Waiting for Single Sign On at the identity provider — complete the sign-in in the Backoffice tab if asked.', job.runId);
  }
});

// --- lifecycle --------------------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  syncContentScripts();
  setBadge('clear');
});
chrome.runtime.onStartup.addListener(() => syncContentScripts());
chrome.permissions.onAdded.addListener(() => syncContentScripts());
chrome.permissions.onRemoved.addListener(() => syncContentScripts());
