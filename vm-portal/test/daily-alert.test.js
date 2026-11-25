/*
 * "Load from Daily Alert" (lib/daily-alert.js) with a stand-in database: which archive rows become tags,
 * which are left out, and which History marks as done. No SQL Server needed.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createDailyAlert } = require('../lib/daily-alert');
const { createFileHistoryDb } = require('../lib/file-history-db');

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', '..', 'hybris-promotag-extension', 'scripts', 'shared', 'alert-parser.js'), 'utf8'));
const parser = globalThis.PTAE.parser;

const ROWS = [ // newest first, as the query returns them
  { at: '2026-11-24T09:30:00', message: '1088 || ELITE 5 FOR $17.80' },
  { at: '2026-11-24T09:30:00', message: 'MT || Count: 0' },
  { at: '2026-11-24T08:00:00', message: '1073 ||  1 FOR 35% OFF' },
  { at: '2026-11-24T08:00:00', message: 'TLOG || Count: 98' },
  { at: '2026-11-23T08:00:00', message: '1088 || ELITE 5 FOR $18.00' }, // older alert for 1088
  { at: '2026-11-23T08:00:00', message: '959 || to change to $30 OFF $199' },
  { at: '2026-11-23T08:00:00', message: '|| no code' },
];

const RUNS = [ // History, newest first
  { tagCode: '959', outcome: 'success', newDesc: '$30 OFF $199', operator: 'willy', finishedAt: 1764000000000 },
  { tagCode: '1073', outcome: 'failed', newDesc: '1 FOR 35% OFF', operator: 'willy', finishedAt: 1764000000000 },
  { tagCode: '1088', outcome: 'success', newDesc: 'ELITE 5 FOR $18.00', operator: 'willy', finishedAt: 1763900000000 },
];
// The portal's own History store (lib/file-history-db.js), so the test reads History as the portal does.
const historyDb = createFileHistoryDb(fs.mkdtempSync(path.join(os.tmpdir(), 'ptae-da-history-')), { newId: (p) => `${p}-${Math.random().toString(36).slice(2)}` });
const historyReady = (async () => {
  for (const [i, r] of RUNS.slice().reverse().entries()) {
    const id = `run-${i}`;
    await historyDb.createRun(Object.assign({ id, startedAt: r.finishedAt - 60000 + i }, r));
    await historyDb.updateRun(id, { outcome: r.outcome, finishedAt: r.finishedAt });
  }
})();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function setup(query) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptae-da-'));
  const calls = [];
  const da = createDailyAlert({
    dataDir: dir,
    historyDb,
    parser,
    query: async (file, days) => {
      calls.push(days);
      return query(file, days);
    },
  });
  return { dir, da, calls, configure: () => fs.writeFileSync(path.join(dir, 'daily-alert.json'), '{}') };
}

test('not set up: no button, and a load says how to set it up', async () => {
  const { da, calls } = setup(async () => ({ ok: true, rows: ROWS }));
  assert.strictEqual(da.configured(), false);
  const r = await da.load(3);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /connect-daily-alert\.cmd/);
  assert.strictEqual(calls.length, 0, 'no query without a login');
});

test('promo tags only, the newest alert per tag, done when History last set that value', async () => {
  const { da, configure } = setup(async () => ({ ok: true, rows: ROWS }));
  configure();
  assert.strictEqual(da.configured(), true);
  const r = await da.load(3);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.days, 3);
  assert.deepStrictEqual(r.items.map((it) => `${it.code}=${it.desc}`), ['1088=ELITE 5 FOR $17.80', '1073=1 FOR 35% OFF', '959=$30 OFF $199']);
  assert.strictEqual(r.items[0].at, '2026-11-24T09:30:00');
  assert.strictEqual(r.items[1].line, '1073 || 1 FOR 35% OFF', 'spaces squashed, original wording kept');
  assert.deepStrictEqual(r.skipped, ['MT || Count: 0', 'TLOG || Count: 98']);
  assert.strictEqual(r.older, 1);
  assert.strictEqual(r.errors.length, 1, 'a promo line without a code is reported');
  assert.strictEqual(r.items[0].done, undefined, '1088: History set the older value, so the new alert is still to do');
  assert.strictEqual(r.items[1].done, undefined, '1073: the last run failed');
  assert.deepStrictEqual(r.items[2].done, { at: 1764000000000, by: 'willy' }, '959: done');
});

test('a range outside Today / 3 / 7 days falls back to 3; the same range at once runs one query', async () => {
  let release;
  const { da, calls, configure } = setup(() => new Promise((res) => { release = () => res({ ok: true, rows: [] }); }));
  configure();
  const a = da.load(7);
  const b = da.load('7');
  await new Promise((r) => setImmediate(r));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepStrictEqual(calls, [7]);
  assert.strictEqual(ra.ok && rb.ok, true);
  assert.deepStrictEqual(ra.items, []);
  const { da: da2, calls: calls2, configure: configure2 } = setup(async () => ({ ok: true, rows: [] }));
  configure2();
  await da2.load(30);
  assert.deepStrictEqual(calls2, [3]);
});

test('a database error is passed on, without the login', async () => {
  const { da, configure } = setup(async () => ({ ok: false, error: "Login failed for user 'reader'." }));
  configure();
  const r = await da.load(1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "Could not read the Daily Alert: Login failed for user 'reader'.");
});

(async () => {
  await historyReady;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${err.message}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} daily-alert tests passed`);
  await historyDb.close();
  process.exit(failed ? 1 : 0);
})();
