/*
 * End-to-end check of the VM portal on this PC (needs Microsoft Edge): the scripted mock Backoffice
 * (dev/tests/fixtures) served over HTTP, the portal server in headless mode, and a second headless
 * Edge acting as the user. The user opens a Teams "Open in Promo Tag Portal" link, creates the first
 * login, sets the Backoffice URL, executes, confirms, then checks History and logs out. Then the
 * portal is stopped the way update-portal.ps1 does it, restarted, and a colleague from users.json logs in.
 *
 * Run: npm test
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const VM = path.resolve(__dirname, '..');
const EXT = path.resolve(VM, '..', 'hybris-promotag-extension');
const FIXTURES = path.resolve(VM, '..', 'dev', 'tests', 'fixtures');
const RECORDS = [{ code: '895', desc: '10% OFF $80' }, { code: '896', desc: '3 FOR $20' }];
const LINK_TEXT = '895 || 10% OFF $70\n896 || 3 FOR $25';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** The mock Backoffice at /backoffice/ (records reset on every page load, like a fresh session). */
async function startMockBackoffice() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://mock').pathname;
    if (p.startsWith('/fixtures/')) {
      const file = path.join(FIXTURES, path.basename(p));
      return fs.readFile(file, (err, buf) => {
        res.writeHead(err ? 404 : 200, { 'Content-Type': 'text/javascript' });
        res.end(err ? '' : buf);
      });
    }
    if (!p.startsWith('/backoffice')) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Backoffice (mock)</title></head><body>
<div id="app"></div>
<script src="/fixtures/backoffice-fixtures.js"></script>
<script src="/fixtures/mock-backoffice.js"></script>
<script>MockBackoffice.reset({ page: 'shell', records: ${JSON.stringify(RECORDS)} });</script>
</body></html>`);
  });
  return { server, port: await listen(server) };
}

async function freePort() {
  const s = http.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

function startPortal(port, dataDir) {
  const child = spawn(process.execPath, ['--use-system-ca', 'server.js'], {
    cwd: VM,
    env: Object.assign({}, process.env, { PTAE_PORT: String(port), PTAE_DATA_DIR: dataDir, PTAE_HEADLESS: '1' }),
  });
  const output = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Portal did not start:\n${output.join('')}`)), 60000);
    const onData = (d) => {
      output.push(String(d));
      if (/Portal: http/.test(String(d))) {
        clearTimeout(timer);
        resolve({ child, output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`Portal exited (${code}):\n${output.join('')}`)));
  });
}

/** What update-portal.ps1 does: POST /api/admin/stop with the token from data/portal.json. */
function stopPortal(port, dataDir, token) {
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'portal.json'), 'utf8'));
  return fetch(`http://localhost:${port}/api/admin/stop`, { method: 'POST', headers: { 'X-PTAE-Stop-Token': token || state.token } });
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
    throw err;
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptae-vm-test-'));
  const mock = await startMockBackoffice();
  const backoffice = `http://127.0.0.1:${mock.port}/backoffice/`;
  const port = await freePort();
  const portal = `http://127.0.0.1:${port}/`;
  let server = null;
  let user = null;
  try {
    server = await startPortal(port, dataDir);
    user = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await user.newPage();

    await step('API refuses visitors without a login; private files are not served', async () => {
      assert.strictEqual((await fetch(`${portal}api/events`)).status, 401);
      assert.strictEqual((await fetch(`${portal}api/shots/shot-x`)).status, 401);
      assert.strictEqual((await fetch(`${portal}ext/scripts/auth-config.js`)).status, 404, 'login hashes');
      assert.strictEqual((await fetch(`${portal}vm/..%2f..%2fvm-portal%2fdata%2fsettings.json`)).status, 404, 'data folder');
      assert.strictEqual((await fetch(`${portal}ext/popup/..%2f..%2fvm-portal%2fserver.js`)).status, 404, 'outside the pages');
      assert.strictEqual((await fetch(`${portal}ext/popup/popup.js`)).status, 200);
    });

    await step('the first login cannot be created from another PC', async () => {
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      if (!lan) return; // no network adapter: nothing to test
      const res = await fetch(`http://${lan.address}:${port}/api/ui`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'UI_SETUP', userId: 'intruder', password: 'whatever-123' }),
      });
      const body = await res.json();
      assert.strictEqual(body.ok, false);
      assert.match(body.error, /on the VM itself/);
    });

    await step('Teams link opens the portal; the first login is created on the VM itself', async () => {
      await page.goto(`${portal}#promotags=${encodeURIComponent(LINK_TEXT)}`);
      await page.waitForSelector('#login-view:not([hidden])');
      assert.strictEqual(await page.textContent('#login-title'), 'Create Portal Login');
      await page.fill('#login-user', 'willy');
      await page.fill('#login-pass', 'portal-key-123');
      await page.fill('#login-pass2', 'portal-key-123');
      await page.click('#login-btn');
      await page.waitForSelector('#portal-view:not([hidden])', { timeout: 30000 });
      assert.strictEqual(new URL(page.url()).hash, '', 'tags removed from the address bar');
    });

    await step('the tags from the link are loaded into the form', async () => {
      const codes = await page.$$eval('#rows .row-code', (els) => els.map((e) => e.value));
      const descs = await page.$$eval('#rows .row-desc', (els) => els.map((e) => e.value));
      assert.deepStrictEqual(codes, ['895', '896']);
      assert.deepStrictEqual(descs, ['10% OFF $70', '3 FOR $25']);
      assert.match(await page.textContent('#parse-note'), /2 tags loaded from the Daily Alert/);
    });

    await step('settings: Backoffice URL and an unreachable Teams workflow', async () => {
      await page.waitForSelector('#settings-panel:not([hidden])');
      assert.ok(!(await page.isVisible('#shots-btn')), 'extension-only setting hidden');
      await page.fill('#set-url', backoffice);
      await page.click('#grant-btn');
      await page.waitForFunction(() => document.getElementById('access-status').textContent === 'Access granted ✓');
      await page.fill('#set-teams-url', 'https://127.0.0.1:1/workflows/test/invoke?sig=x');
      await page.click('#teams-save-btn');
      await page.waitForFunction(() => document.getElementById('teams-status').textContent === 'Auto-reply on ✓');
    });

    await step('Execute → confirm old → new (the updater cannot stop the portal meanwhile) → both verified', async () => {
      await page.click('#execute-btn');
      await page.waitForSelector('#confirm-panel:not([hidden])', { timeout: 90000 });
      assert.strictEqual(await page.textContent('#cf-old'), '10% OFF $80');
      assert.strictEqual(await page.textContent('#cf-new'), '10% OFF $70');
      assert.strictEqual((await stopPortal(port, dataDir)).status, 409, 'no stop while a run waits for confirmation');
      await page.click('#cf-all');
      await page.waitForFunction(() => /^Finished/.test(document.getElementById('run-title').textContent), null, { timeout: 120000 });
      assert.strictEqual(await page.textContent('#run-title'), 'Finished — 2 verified');
    });

    await step('Teams reply attempted; the failure is shown with Retry', async () => {
      await page.waitForFunction(() => /Teams reply not sent/.test(document.getElementById('teams-note').textContent), null, { timeout: 90000 });
      assert.match(await page.textContent('#teams-note'), /Could not reach the Teams workflow/);
      assert.ok(await page.isVisible('#rs-teams'), 'Retry Teams reply offered');
    });

    await step('History lists both runs with their screenshots', async () => {
      const [history] = await Promise.all([page.waitForEvent('popup'), page.click('#history-btn')]);
      await history.waitForSelector('#app:not([hidden])');
      await history.waitForFunction(() => document.querySelectorAll('#rows tr').length >= 2);
      const text = await history.textContent('#rows');
      assert.match(text, /895/);
      assert.match(text, /10% OFF \$80\s*→\s*10% OFF \$70/);
      assert.match(await history.textContent('#usage'), /2 runs · 4 screenshots · [\d.]+ MB used/);
      await history.click('#rows tr');
      await history.waitForFunction(() => document.querySelectorAll('#d-shots img').length === 2);
      const ok = await history.$$eval('#d-shots img', (imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0));
      assert.ok(ok, 'screenshots load');
      await history.close();
    });

    await step('Logout ends only this visitor’s login', async () => {
      await page.click('#logout-btn');
      await page.waitForSelector('#login-view:not([hidden])');
      assert.strictEqual(await page.textContent('#login-title'), 'Promo Tag Portal Login');
      const res = await page.evaluate(() => fetch('/api/events').then((r) => r.status));
      assert.strictEqual(res, 401);
    });

    await step('update-portal stop: needs the token, then stops with exit code 3', async () => {
      assert.strictEqual((await stopPortal(port, dataDir, 'wrong-token')).status, 403);
      const exited = new Promise((resolve) => server.child.on('exit', resolve));
      assert.strictEqual((await stopPortal(port, dataDir)).status, 200);
      assert.strictEqual(await exited, 3, 'start-portal.cmd closes its window on exit code 3');
      assert.ok(!fs.existsSync(path.join(dataDir, 'portal.json')), 'state file removed');
    });

    await step('after a restart: History kept; a colleague logs in with an entry from users.json', async () => {
      vm.runInThisContext(fs.readFileSync(path.join(EXT, 'scripts', 'shared', 'auth-crypto.js'), 'utf8'));
      const rec = await globalThis.PTAE.authCrypto.hashCredential('colleague', 'colleague-key-1');
      fs.writeFileSync(path.join(dataDir, 'users.json'), `${JSON.stringify(rec, null, 2)},\n`); // as the hasher shows it
      server = await startPortal(port, dataDir);
      assert.ok(server.output.join('').includes('Portal logins from users.json: colleague'));
      const other = await user.newContext();
      const p2 = await other.newPage();
      await p2.goto(portal);
      await p2.waitForSelector('#login-view:not([hidden])');
      assert.strictEqual(await p2.textContent('#login-title'), 'Promo Tag Portal Login');
      await p2.fill('#login-user', 'colleague');
      await p2.fill('#login-pass', 'colleague-key-1');
      await p2.click('#login-btn');
      await p2.waitForSelector('#portal-view:not([hidden])', { timeout: 30000 });
      assert.match(await p2.textContent('#whoami'), /Signed in as colleague/);
      const counts = await p2.evaluate(() => fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'counts', args: [] }),
      }).then((r) => r.json()));
      assert.strictEqual(counts.result.runs, 2, 'History kept across restarts');
      await other.close();
    });
  } finally {
    if (user) await user.close().catch(() => {});
    if (server) {
      server.child.kill();
      await new Promise((r) => setTimeout(r, 1500));
    }
    mock.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    console.log(results.join('\n'));
    if (server && results.some((r) => r.startsWith('FAIL'))) console.log(`\nPortal output:\n${server.output.join('')}`);
  }
}

main().then(
  () => console.log(`\n${results.length}/${results.length} passed`),
  () => {
    console.log('\nFAILED');
    process.exitCode = 1;
  }
);
