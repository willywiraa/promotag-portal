/*
 * Promo Tag Portal on a Windows VM (see DEPLOY-VM.md).
 *
 * Serves the extension's own portal and History pages to the network, and runs the extension's own
 * service worker (background.js) in Node with Microsoft Edge, driven by Playwright, as the browser.
 * The automation, batching, verification, history and Teams reply are the extension's code; this file
 * adds the web server: per-visitor logins (cookies), the page API, live updates and screenshots.
 *
 * Environment: PTAE_PORT (8080), PTAE_DATA_DIR (./data), PTAE_HEADLESS=1 (no Edge window; tests only).
 * data/users.json: extra portal logins for this VM (entries from dev/tools/credential-hasher.html).
 * data/portal.json: port, process id and stop token of the running portal, for update-portal.ps1.
 */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { randomBytes } = require('crypto');
const { createChrome, routeBackofficeFetch, requestContext, EXTENSION_ID } = require('./lib/chrome-shim');
const { createFileHistoryDb } = require('./lib/file-history-db');

const EXT = path.resolve(__dirname, '..', 'hybris-promotag-extension');
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PTAE_PORT) || 8080;
const DATA = path.resolve(process.env.PTAE_DATA_DIR || path.join(__dirname, 'data'));
const HEADLESS = process.env.PTAE_HEADLESS === '1';
const VERSION = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
const UI_SENDER = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` };
const EXT_FOLDERS = ['popup/', 'history/', 'scripts/shared/', 'assets/'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/png' };
const HISTORY_CALLS = new Set(['listRuns', 'getRun', 'getLogs', 'getScreenshotsForRun', 'deleteRun', 'deleteRunsBefore', 'counts']);
const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const STATE_FILE = path.join(DATA, 'portal.json');
const STOP_TOKEN = randomBytes(24).toString('hex');
const EXIT_FOR_UPDATE = 3; // start-portal.cmd closes its window on this code

fs.mkdirSync(DATA, { recursive: true });

/** data/users.json: entries pasted from the credential hasher, with or without [ ] and trailing commas. */
function vmUsers() {
  const file = path.join(DATA, 'users.json');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim().replace(/,\s*$/, '');
  try {
    const list = JSON.parse(text.startsWith('[') ? text.replace(/,\s*]$/, ']') : `[${text}]`);
    console.log(`Portal logins from users.json: ${list.map((u) => u.userId).join(', ') || 'none'}`);
    return list;
  } catch (err) {
    console.error(`users.json ignored, it is not valid: ${err.message}`);
    return [];
  }
}

// --- the extension's service worker, in Node -------------------------------------------------------
const { chrome, host, dispatch } = createChrome({
  settingsFile: path.join(DATA, 'settings.json'),
  edge: { extDir: EXT, profileDir: path.join(DATA, 'edge-profile'), channel: 'msedge', headless: HEADLESS, viewport: { width: 1600, height: 900 } },
});
routeBackofficeFetch(host, chrome.storage.local);

function runScript(file) {
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

globalThis.chrome = chrome;
globalThis.importScripts = (...files) => {
  files.forEach((f) => runScript(path.join(EXT, 'scripts', f)));
  // History goes to files instead of IndexedDB; ids and CSV export stay the extension's.
  const P = globalThis.PTAE;
  P.historyDb = createFileHistoryDb(path.join(DATA, 'history'), { newId: P.historyDb.newId, toCsv: P.historyDb.toCsv });
  // Logins kept on the VM, so updates from Git never touch them.
  P.AUTH_CONFIG.users = P.AUTH_CONFIG.users.concat(vmUsers());
};
runScript(path.join(EXT, 'scripts', 'background.js'));
const DB = globalThis.PTAE.historyDb;
chrome.runtime.onInstalled.emit({ reason: 'update' });

// --- visitors' logins --------------------------------------------------------------------------------
const sessions = new Map(); // token -> portal session (created by background.js on login)

function readCookie(req) {
  const m = /(?:^|;\s*)ptae_sid=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function visitorSession(req) {
  const token = readCookie(req);
  const s = token ? sessions.get(token) : null;
  if (s && s.expiresAt > Date.now()) return s;
  if (token) sessions.delete(token);
  return null;
}

function sessionCookie(s) {
  if (!s) return 'ptae_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  const age = Math.max(0, Math.floor((s.expiresAt - Date.now()) / 1000));
  return `ptae_sid=${encodeURIComponent(s.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/** Portal page messages (UI_*): the visitor's login is passed to background.js for this request only. */
async function handleUi(req, msg) {
  const ctx = { session: visitorSession(req), sessionChanged: false };
  let resp;
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('UI_')) {
    resp = { ok: false, error: 'Unknown request.' };
  } else if (msg.type === 'UI_LOGOUT') {
    // Only this visitor signs out; a run started by someone else keeps going.
    if (ctx.session) sessions.delete(ctx.session.token);
    Object.assign(ctx, { session: null, sessionChanged: true });
    resp = { ok: true };
  } else if (msg.type === 'UI_SETUP' && !isLocal(req)) {
    resp = { ok: false, error: `Create the first portal login on the VM itself: open http://localhost:${PORT}/ there.` };
  } else if (msg.type === 'UI_OPEN_HISTORY') {
    resp = { ok: true }; // the page opens /history itself
  } else {
    resp = await requestContext.run(ctx, () => dispatch(msg, UI_SENDER));
  }
  if (ctx.sessionChanged && ctx.session) sessions.set(ctx.session.token, ctx.session);
  return { resp: resp || { ok: false, error: 'No response.' }, cookie: ctx.sessionChanged ? sessionCookie(ctx.session) : null };
}

// --- live updates for open portal pages (server-sent events) ----------------------------------------
const streams = new Set();
let printed = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  const out = {};
  ['job', 'batch', 'logs'].forEach((k) => {
    if (k in changes) out[k] = { newValue: changes[k].newValue };
  });
  if (!Object.keys(out).length) return;
  const line = `data: ${JSON.stringify({ area, changes: out })}\n\n`;
  streams.forEach((res) => res.write(line));
  // The console window doubles as a run log on the VM.
  const logs = (changes.logs && changes.logs.newValue) || null;
  if (logs) {
    logs.filter((e) => e.t > printed).forEach((e) => console.log(`${new Date(e.t).toLocaleTimeString()}  ${e.msg}`));
    printed = logs.length ? logs[logs.length - 1].t : printed;
  }
});
setInterval(() => streams.forEach((res) => res.write(': keep-alive\n\n')), 25000).unref();

// --- pages --------------------------------------------------------------------------------------------
/** The extension's page, with its files served from /ext/ and the web shim added before its script. */
function extensionPage(file, script, extraScripts) {
  const dir = path.posix.dirname(file);
  let html = fs.readFileSync(path.join(EXT, file), 'utf8');
  html = html.replace(/(src|href)="(?!https?:|\/|#|data:)([^"]+)"/g, (m, attr, rel) => `${attr}="/ext/${path.posix.normalize(`${dir}/${rel}`)}"`);
  const head = `<meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="ptae-version" content="${VERSION}">
  <link rel="icon" href="/ext/assets/icon-48.png">
  <link rel="stylesheet" href="/vm/web.css">`;
  html = html.replace('</head>', `  ${head}\n</head>`);
  const shims = extraScripts.concat('/vm/web-shim.js').map((s) => `<script src="${s}"></script>`).join('\n  ');
  return html.replace(`<script src="/ext/${script}"></script>`, (m) => `${shims}\n  ${m}`);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, headers));
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers));
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

/** A file under `root`, refusing anything outside it. */
function within(root, rel) {
  const file = path.resolve(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(new Error('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://portal');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = extensionPage('popup/popup.html', 'popup/popup.js', ['/ext/scripts/shared/teams.js']);
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-cache' });
  }
  if (req.method === 'GET' && p === '/history') {
    const html = extensionPage('history/history.html', 'history/history.js', []);
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-cache' });
  }
  if (req.method === 'GET' && p === '/favicon.ico') return sendFile(res, path.join(EXT, 'assets', 'icon-48.png'));
  if (req.method === 'GET' && p.startsWith('/ext/')) {
    const rel = decodeURIComponent(p.slice(5));
    const file = EXT_FOLDERS.some((f) => rel.startsWith(f)) ? within(EXT, rel) : null;
    return file ? sendFile(res, file) : send(res, 404, 'Not found');
  }
  if (req.method === 'GET' && p.startsWith('/vm/')) {
    const file = within(PUBLIC, decodeURIComponent(p.slice(4)));
    return file ? sendFile(res, file) : send(res, 404, 'Not found');
  }

  // update-portal.ps1 on the VM itself: stop, unless a run is in progress.
  if (req.method === 'POST' && p === '/api/admin/stop') {
    if (!isLocal(req) || req.headers['x-ptae-stop-token'] !== STOP_TOKEN) return sendJson(res, 403, { ok: false, error: 'Not allowed.' });
    const { batch } = await chrome.storage.session.get('batch');
    if (globalThis.PTAE.batch.isActive(batch)) return sendJson(res, 409, { ok: false, error: 'A run is in progress.' });
    sendJson(res, 200, { ok: true });
    setTimeout(() => shutdown(EXIT_FOR_UPDATE), 100);
    return undefined;
  }

  if (req.method === 'POST' && p === '/api/ui') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { ok: false, error: 'JSON only.' });
    const { resp, cookie } = await handleUi(req, await readJson(req));
    return sendJson(res, 200, resp, cookie ? { 'Set-Cookie': cookie } : {});
  }

  // Everything below needs a portal login.
  if (!visitorSession(req)) return sendJson(res, 401, { ok: false, error: 'Portal session expired — please log in again.', code: 'AUTH' });

  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return undefined;
  }
  if (req.method === 'POST' && p === '/api/history') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { ok: false, error: 'JSON only.' });
    const { method, args } = await readJson(req);
    if (!HISTORY_CALLS.has(method)) return sendJson(res, 400, { ok: false, error: 'Unknown history call.' });
    const result = await DB[method](...(Array.isArray(args) ? args : []));
    if (method === 'getScreenshotsForRun') result.forEach((s) => delete s.file);
    return sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
  }
  const shot = /^\/api\/shots\/([\w-]{1,80})$/.exec(p);
  if (req.method === 'GET' && shot) {
    const file = DB.screenshotPath(shot[1]);
    return file ? sendFile(res, file) : send(res, 404, 'Not found');
  }
  return send(res, 404, 'Not found');
}

// --- start ----------------------------------------------------------------------------------------------
process.on('unhandledRejection', (err) => console.error('Unexpected error:', err));

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    else res.end();
  });
});

async function main() {
  console.log(`Promo Tag Portal ${VERSION} — data in ${DATA}`);
  try {
    await host.start();
    console.log(`Microsoft Edge started${HEADLESS ? ' (headless)' : ''}.`);
  } catch (err) {
    console.error(`Microsoft Edge did not start: ${err.message}\nThe portal opens anyway; Edge is retried on the next run.`);
  }
  server.listen(PORT, () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ port: PORT, pid: process.pid, token: STOP_TOKEN, started: new Date().toISOString() }));
    console.log(`Portal: http://localhost:${PORT}/  (from other PCs: http://${os.hostname()}:${PORT}/)`);
    console.log('Keep this window open. Press Ctrl+C to stop.');
  });
}

async function shutdown(code = 0) {
  console.log(code === EXIT_FOR_UPDATE ? 'Stopping for an update…' : 'Stopping…');
  server.close();
  await host.stop();
  await DB.close();
  fs.rmSync(STATE_FILE, { force: true });
  process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

main();
