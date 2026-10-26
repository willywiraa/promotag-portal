/*
 * History database on disk, with the same interface as the extension's IndexedDB one
 * (scripts/shared/history-db.js): runs.json holds the runs and screenshot records, one JSON-lines
 * file per run holds its log, and each screenshot is an image file.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SAFE_ID = /^[\w-]{1,80}$/;
const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

function textMatch(run, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  return [run.tagCode, run.oldDesc, run.newDesc, run.message, run.operator]
    .some((v) => v != null && String(v).toLowerCase().includes(needle));
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** helpers: { newId, toCsv } from the extension's history-db.js, so ids and CSV stay identical. */
function createFileHistoryDb(dir, helpers) {
  const shotsDir = path.join(dir, 'screenshots');
  const logsDir = path.join(dir, 'logs');
  const indexFile = path.join(dir, 'runs.json');
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  let data = { runs: {}, shots: {} };
  try {
    data = Object.assign(data, JSON.parse(fs.readFileSync(indexFile, 'utf8')));
  } catch (_) {
    /* first start */
  }

  let writing = Promise.resolve();
  function save() {
    const json = JSON.stringify(data);
    writing = writing
      .then(async () => {
        await fs.promises.writeFile(`${indexFile}.tmp`, json);
        await fs.promises.rename(`${indexFile}.tmp`, indexFile);
      })
      .catch((err) => console.error(`History not saved: ${err.message}`));
    return writing;
  }

  function checkId(id) {
    if (!SAFE_ID.test(String(id))) throw new Error('Invalid id.');
    return String(id);
  }

  const logFile = (runId) => path.join(logsDir, `${checkId(runId)}.jsonl`);

  function shotsOf(runId) {
    return Object.values(data.shots).filter((s) => s.runId === runId).sort((a, b) => a.takenAt - b.takenAt);
  }

  async function removeRun(id) {
    shotsOf(id).forEach((s) => {
      delete data.shots[s.id];
      fs.promises.unlink(path.join(shotsDir, s.file)).catch(() => {});
    });
    delete data.runs[id];
    await fs.promises.unlink(logFile(id)).catch(() => {});
  }

  return {
    newId: helpers.newId,
    toCsv: helpers.toCsv,

    async createRun(run) {
      const rec = Object.assign({ screenshotIds: [], outcome: 'running', message: '', verify: null }, run);
      data.runs[checkId(rec.id)] = rec;
      await save();
      return clone(rec);
    },

    async updateRun(id, patch) {
      if (!data.runs[id]) return null;
      data.runs[id] = Object.assign({}, data.runs[id], patch);
      await save();
      return clone(data.runs[id]);
    },

    async getRun(id) {
      return clone(data.runs[id] || null);
    },

    /** Newest first. Filters: tagCode (exact), outcome, from/to (ms), text (substring). */
    async listRuns(opts = {}) {
      const { tagCode, outcome, from, to, text, limit = 50, offset = 0 } = opts;
      const all = Object.values(data.runs)
        .filter((r) => (from == null || r.startedAt >= from) && (to == null || r.startedAt <= to))
        .filter((r) => (!tagCode || r.tagCode === tagCode) && (!outcome || r.outcome === outcome) && textMatch(r, text))
        .sort((a, b) => b.startedAt - a.startedAt);
      return { items: clone(all.slice(offset, offset + limit)), hasMore: all.length > offset + limit };
    },

    async appendLog(runId, entry) {
      const rec = { runId, t: entry.t || Date.now(), level: entry.level || 'info', msg: String(entry.msg) };
      await fs.promises.appendFile(logFile(runId), `${JSON.stringify(rec)}\n`);
    },

    async getLogs(runId) {
      let text;
      try {
        text = await fs.promises.readFile(logFile(runId), 'utf8');
      } catch (_) {
        return [];
      }
      return text.split('\n').filter(Boolean).map((line, i) => Object.assign({ id: i + 1 }, JSON.parse(line)));
    },

    /** Stores the image file and links it to its run. shot: { runId, kind, blob, mime, … } */
    async addScreenshot(shot) {
      const { blob, ...meta } = shot;
      const id = helpers.newId('shot');
      const file = `${id}.${FILE_TYPES[meta.mime] || 'png'}`;
      const bytes = Buffer.from(await blob.arrayBuffer());
      await fs.promises.writeFile(path.join(shotsDir, file), bytes);
      data.shots[id] = Object.assign({ id, takenAt: Date.now(), kind: 'manual' }, meta, { file, bytes: bytes.length });
      const run = data.runs[meta.runId];
      if (run && !run.screenshotIds.includes(id)) run.screenshotIds = run.screenshotIds.concat(id);
      await save();
      return id;
    },

    /** The screenshot record with its image as a Blob, like the extension's database. */
    async getScreenshot(id) {
      const s = data.shots[id];
      if (!s) return null;
      const bytes = await fs.promises.readFile(path.join(shotsDir, s.file));
      return Object.assign(clone(s), { blob: new Blob([bytes], { type: s.mime || 'image/png' }) });
    },

    async getScreenshotsForRun(runId) {
      return clone(shotsOf(runId));
    },

    /** Absolute path of a screenshot's image file, or null. */
    screenshotPath(id) {
      const s = data.shots[id];
      return s ? path.join(shotsDir, s.file) : null;
    },

    async deleteRun(id) {
      await removeRun(checkId(id));
      await save();
    },

    /** Deletes every run started before `ts` (with its logs and screenshots). Resolves with the count. */
    async deleteRunsBefore(ts) {
      const old = Object.values(data.runs).filter((r) => r.startedAt < ts);
      for (const r of old) await removeRun(r.id);
      await save();
      return old.length;
    },

    async counts() {
      const shots = Object.values(data.shots);
      return { runs: Object.keys(data.runs).length, screenshots: shots.length, bytes: shots.reduce((n, s) => n + (s.bytes || 0), 0) };
    },

    close() {
      return writing;
    },
  };
}

module.exports = { createFileHistoryDb };
