/*
 * "Load from Daily Alert": the promo tag alerts of the last few days, read from DAILY_ALERT_ARCHIVE when
 * someone clicks the button (never on a timer), with the tags History shows as done marked.
 * The portal only reads the table and fills the form: nothing is saved until someone clicks Execute.
 *
 * data/daily-alert.json (written by connect-daily-alert.cmd, never in Git): server, database, user,
 * password (encrypted for the Windows user who ran the setup), optional table.
 * The query itself is lib/daily-alert-query.ps1, run by Windows PowerShell with .NET's SQL client,
 * so the portal needs no database library.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const QUERY_SCRIPT = path.join(__dirname, 'daily-alert-query.ps1');
const DAYS = [1, 3, 7];
const DONE_OUTCOMES = new Set(['success', 'already-up-to-date']);

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Runs the query script; resolves to { ok, rows } or { ok: false, error }. */
function runQuery(configFile, days) {
  const encoded = Buffer.from(fs.readFileSync(QUERY_SCRIPT, 'utf8'), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: Object.assign({}, process.env, { PTAE_ALERT_CONFIG: configFile, PTAE_ALERT_DAYS: String(days) }),
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      const line = String(stdout || '').split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
      if (line) {
        try {
          return resolve(JSON.parse(line));
        } catch (_) {
          /* reported below */
        }
      }
      resolve({ ok: false, error: err && err.killed ? 'The database did not answer within a minute.' : `The database query did not run${err ? ` (${err.message.split('\n')[0]})` : ''}.` });
    });
  });
}

/**
 * Archive rows (newest first) -> one candidate per tag code, the newest alert for it.
 * `lastDone(code)`: the newest History run of that tag that saved or found its value, or null.
 */
async function toCandidates(rows, parser, lastDone) {
  const items = [];
  const skipped = [];
  const errors = [];
  let older = 0;
  for (const row of rows) {
    const line = squash(row.message);
    const r = parser.parseAlert(line);
    if (parser.isOtherAlert(r)) {
      skipped.push(line);
      continue;
    }
    if (r.error) {
      errors.push(`"${line}": ${r.error}`);
      continue;
    }
    if (items.some((it) => it.code === r.code)) {
      older++; // an earlier alert for the same tag: the newest one wins
      continue;
    }
    items.push({ code: r.code, desc: r.desc, line, at: row.at || '' });
  }
  for (const it of items) {
    const run = await lastDone(it.code);
    // Done only if the last value set is this alert's value (a later alert can ask for another one).
    if (run && squash(run.newDesc) === squash(it.desc)) it.done = { at: run.finishedAt || run.startedAt || null, by: run.operator || '' };
  }
  return { items, skipped, errors, older };
}

function createDailyAlert({ dataDir, historyDb, parser, query = runQuery }) {
  const configFile = path.join(dataDir, 'daily-alert.json');
  const busy = new Map(); // days -> the query running for that range: two clicks at once share it

  const configured = () => fs.existsSync(configFile);

  async function lastDone(code) {
    const { items } = await historyDb.listRuns({ tagCode: code, limit: 50 }); // newest first
    return (items || []).find((r) => DONE_OUTCOMES.has(r.outcome)) || null;
  }

  async function load(days) {
    if (!configured()) return { ok: false, error: 'The Daily Alert database is not set up on this VM: run connect-daily-alert.cmd there (DEPLOY-VM.md, step 12).' };
    const d = DAYS.includes(Number(days)) ? Number(days) : 3;
    if (!busy.has(d)) busy.set(d, Promise.resolve(query(configFile, d)).finally(() => busy.delete(d)));
    const res = await busy.get(d);
    if (!res || !res.ok) return { ok: false, error: `Could not read the Daily Alert: ${(res && res.error) || 'no answer'}` };
    const out = await toCandidates(Array.isArray(res.rows) ? res.rows : [], parser, lastDone);
    return Object.assign({ ok: true, days: d }, out);
  }

  return { configured, load };
}

module.exports = { createDailyAlert, toCandidates, DAYS };
