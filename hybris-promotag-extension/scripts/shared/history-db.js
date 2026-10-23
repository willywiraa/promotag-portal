/*
 * Local history database (IndexedDB, extension origin): every amendment run with its
 * old -> new values, outcome, full log trail and screenshots. Written only by the service
 * worker; read by the popup and the History page.
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});
  const DB_VERSION = 1;

  function newId(prefix) {
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now().toString(36)}-${rnd}`;
  }

  function textMatch(run, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    return [run.tagCode, run.oldDesc, run.newDesc, run.message, run.operator]
      .some((v) => v != null && String(v).toLowerCase().includes(needle));
  }

  function csvCell(value) {
    let s = value == null ? '' : String(value);
    // Stop spreadsheet apps from evaluating cells as formulas.
    if (/^[=+@\t\r]/.test(s) || /^-[^\d\s]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function iso(ts) {
    return ts ? new Date(ts).toISOString() : '';
  }

  /** Pure: runs -> CSV text (no images). */
  function toCsv(runs) {
    const head = ['run_id', 'started_at', 'finished_at', 'operator', 'tag_code', 'old_description', 'new_description',
      'outcome', 'verify_attempts', 'grid_value', 'message', 'backoffice_url'];
    const rows = (runs || []).map((r) => [
      r.id, iso(r.startedAt), iso(r.finishedAt), r.operator, r.tagCode, r.oldDesc, r.newDesc, r.outcome,
      r.verify ? r.verify.attempts : '', r.verify ? r.verify.observed : '', r.message, r.backofficeUrl,
    ].map(csvCell).join(','));
    return [head.join(',')].concat(rows).join('\r\n');
  }

  function createHistoryDb(name) {
    let dbPromise = null;

    function open() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(name, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('runs')) {
              const runs = db.createObjectStore('runs', { keyPath: 'id' });
              runs.createIndex('startedAt', 'startedAt');
              runs.createIndex('tagCode', 'tagCode');
              runs.createIndex('outcome', 'outcome');
            }
            if (!db.objectStoreNames.contains('logs')) {
              db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true }).createIndex('runId', 'runId');
            }
            if (!db.objectStoreNames.contains('screenshots')) {
              db.createObjectStore('screenshots', { keyPath: 'id' }).createIndex('runId', 'runId');
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => {
              db.close();
              dbPromise = null;
            };
            resolve(db);
          };
          req.onerror = () => {
            dbPromise = null;
            reject(req.error);
          };
        });
      }
      return dbPromise;
    }

    /** Runs fn(tx, setResult) inside one transaction; resolves with the result once it commits. */
    async function withTx(stores, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        try {
          fn(tx, (v) => { result = v; });
        } catch (err) {
          try { tx.abort(); } catch (_) { /* already finished */ }
          reject(err);
        }
      });
    }

    function deleteByIndex(store, runId) {
      const cur = store.index('runId').openKeyCursor(IDBKeyRange.only(runId));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        store.delete(c.primaryKey);
        c.continue();
      };
    }

    function deleteRunInTx(tx, id) {
      tx.objectStore('runs').delete(id);
      deleteByIndex(tx.objectStore('logs'), id);
      deleteByIndex(tx.objectStore('screenshots'), id);
    }

    return {
      newId,
      toCsv,

      createRun(run) {
        const rec = Object.assign({ screenshotIds: [], outcome: 'running', message: '', verify: null }, run);
        return withTx(['runs'], 'readwrite', (tx) => tx.objectStore('runs').put(rec)).then(() => rec);
      },

      updateRun(id, patch) {
        return withTx(['runs'], 'readwrite', (tx, set) => {
          const store = tx.objectStore('runs');
          const get = store.get(id);
          get.onsuccess = () => {
            if (!get.result) return set(null);
            const next = Object.assign({}, get.result, patch);
            store.put(next);
            set(next);
          };
        });
      },

      getRun(id) {
        return withTx(['runs'], 'readonly', (tx, set) => {
          const get = tx.objectStore('runs').get(id);
          get.onsuccess = () => set(get.result || null);
        });
      },

      /** Newest first. Filters: tagCode (exact), outcome, from/to (ms), text (substring). */
      listRuns(opts = {}) {
        const { tagCode, outcome, from, to, text, limit = 50, offset = 0 } = opts;
        return withTx(['runs'], 'readonly', (tx, set) => {
          const items = [];
          let skipped = 0;
          let hasMore = false;
          let range = null;
          if (from != null && to != null) range = IDBKeyRange.bound(from, to);
          else if (from != null) range = IDBKeyRange.lowerBound(from);
          else if (to != null) range = IDBKeyRange.upperBound(to);
          const cur = tx.objectStore('runs').index('startedAt').openCursor(range, 'prev');
          set({ items, hasMore: false });
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return set({ items, hasMore });
            const r = c.value;
            const ok = (!tagCode || r.tagCode === tagCode) && (!outcome || r.outcome === outcome) && textMatch(r, text);
            if (ok) {
              if (skipped < offset) skipped++;
              else if (items.length < limit) items.push(r);
              else {
                hasMore = true;
                return set({ items, hasMore });
              }
            }
            c.continue();
          };
        });
      },

      appendLog(runId, entry) {
        const rec = { runId, t: entry.t || Date.now(), level: entry.level || 'info', msg: String(entry.msg) };
        return withTx(['logs'], 'readwrite', (tx) => tx.objectStore('logs').add(rec));
      },

      getLogs(runId) {
        return withTx(['logs'], 'readonly', (tx, set) => {
          const req = tx.objectStore('logs').index('runId').getAll(IDBKeyRange.only(runId));
          req.onsuccess = () => set((req.result || []).sort((a, b) => a.id - b.id));
        });
      },

      /** Stores the screenshot and links it to its run in the same transaction. */
      addScreenshot(shot) {
        const rec = Object.assign({ id: newId('shot'), takenAt: Date.now(), kind: 'manual' }, shot);
        return withTx(['screenshots', 'runs'], 'readwrite', (tx, set) => {
          tx.objectStore('screenshots').put(rec);
          const runs = tx.objectStore('runs');
          const get = runs.get(rec.runId);
          get.onsuccess = () => {
            if (!get.result) return;
            const ids = (get.result.screenshotIds || []).slice();
            if (!ids.includes(rec.id)) ids.push(rec.id);
            runs.put(Object.assign({}, get.result, { screenshotIds: ids }));
          };
          set(rec.id);
        });
      },

      getScreenshot(id) {
        return withTx(['screenshots'], 'readonly', (tx, set) => {
          const get = tx.objectStore('screenshots').get(id);
          get.onsuccess = () => set(get.result || null);
        });
      },

      getScreenshotsForRun(runId) {
        return withTx(['screenshots'], 'readonly', (tx, set) => {
          const req = tx.objectStore('screenshots').index('runId').getAll(IDBKeyRange.only(runId));
          req.onsuccess = () => set((req.result || []).sort((a, b) => a.takenAt - b.takenAt));
        });
      },

      deleteRun(id) {
        return withTx(['runs', 'logs', 'screenshots'], 'readwrite', (tx) => deleteRunInTx(tx, id));
      },

      /** Deletes every run started before `ts` (with its logs and screenshots). Resolves with the count. */
      deleteRunsBefore(ts) {
        return withTx(['runs', 'logs', 'screenshots'], 'readwrite', (tx, set) => {
          let count = 0;
          set(0);
          const cur = tx.objectStore('runs').index('startedAt').openKeyCursor(IDBKeyRange.upperBound(ts, true));
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return set(count);
            deleteRunInTx(tx, c.primaryKey);
            count++;
            c.continue();
          };
        });
      },

      counts() {
        return withTx(['runs', 'screenshots'], 'readonly', (tx, set) => {
          const out = { runs: 0, screenshots: 0 };
          set(out);
          const a = tx.objectStore('runs').count();
          a.onsuccess = () => { out.runs = a.result; };
          const b = tx.objectStore('screenshots').count();
          b.onsuccess = () => { out.screenshots = b.result; };
        });
      },

      close() {
        if (!dbPromise) return Promise.resolve();
        return dbPromise.then((db) => { db.close(); dbPromise = null; });
      },
    };
  }

  PTAE.createHistoryDb = createHistoryDb;
  PTAE.historyDb = createHistoryDb('ptae-history');
})(globalThis);
