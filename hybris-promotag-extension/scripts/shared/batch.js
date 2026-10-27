/*
 * Batch of tag amendments, run one after another in the same Backoffice tab.
 * Pure functions (no chrome.* APIs): the service worker stores the batch in chrome.storage.session
 * and calls these to move it forward; the tests exercise them directly.
 *
 * Item status: pending → running ⇄ awaiting_confirm → succeeded | unchanged | failed | skipped | stopped
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});

  const MAX_ITEMS = 25;
  // Failures that make the remaining tags pointless (environment problems, not tag problems).
  const STOP_CODES = new Set(['NETWORK', 'SESSION', 'DIALOG', 'TAB_CLOSED', 'TAB', 'STALLED']);
  const DONE = new Set(['succeeded', 'unchanged', 'failed', 'skipped', 'stopped']);

  const copy = (b) => JSON.parse(JSON.stringify(b));

  /** Validates rows from the portal: [{code, newDesc, rawLine?}] → {items, errors}. */
  function normalizeItems(rows, parser) {
    const items = [];
    const errors = [];
    (rows || []).forEach((row, i) => {
      const code = String((row && row.code) || '').trim();
      const newDesc = String((row && row.newDesc) || '').trim();
      if (!code && !newDesc) return; // blank row
      const err = parser.validateCode(code) || parser.validateDesc(newDesc);
      if (err) {
        errors.push(`Row ${i + 1}: ${err}`);
        return;
      }
      if (items.some((it) => it.code === code)) {
        errors.push(`Row ${i + 1}: Tag ${code} is listed more than once.`);
        return;
      }
      items.push({ code, newDesc, rawLine: String((row && row.rawLine) || `${code} || ${newDesc}`) });
    });
    if (items.length > MAX_ITEMS) errors.push(`At most ${MAX_ITEMS} tags per run (got ${items.length}).`);
    return { items, errors };
  }

  function createBatch({ id, items, operator, confirmBeforeSave, now = Date.now() }) {
    return {
      id,
      operator,
      startedAt: now,
      updatedAt: now,
      status: 'running', // running | stopping | done | stopped
      confirmBeforeSave: confirmBeforeSave !== false,
      confirmAll: false,
      current: -1,
      items: items.map((it, index) => ({
        index,
        code: it.code,
        newDesc: it.newDesc,
        rawLine: it.rawLine,
        status: 'pending',
        outcome: null,
        oldDesc: null,
        message: '',
        errorCode: null,
        jobId: null,
        runId: null,
        attempts: null,
        shotMissing: false,
        finishedAt: null,
      })),
    };
  }

  function nextIndex(batch) {
    return batch.items.findIndex((it) => it.status === 'pending');
  }

  function startItem(batch, index, ids, now = Date.now()) {
    const b = copy(batch);
    Object.assign(b.items[index], { status: 'running', jobId: ids.jobId, runId: ids.runId });
    b.current = index;
    b.updatedAt = now;
    return b;
  }

  function markItem(batch, index, status, now = Date.now()) {
    const b = copy(batch);
    if (b.items[index] && !DONE.has(b.items[index].status)) b.items[index].status = status;
    b.updatedAt = now;
    return b;
  }

  function statusForOutcome(outcome) {
    return { success: 'succeeded', 'already-up-to-date': 'unchanged', cancelled: 'skipped', aborted: 'stopped' }[outcome] || 'failed';
  }

  function skipRemaining(b, message) {
    b.items.forEach((it) => {
      if (it.status === 'pending') Object.assign(it, { status: 'skipped', message });
    });
  }

  /**
   * Records an item's result and decides what happens next.
   * @returns {{batch: object, action: 'next'|'stop'|'done'}}
   */
  function applyResult(batch, index, result, now = Date.now()) {
    const b = copy(batch);
    const item = b.items[index];
    if (item) {
      Object.assign(item, {
        status: statusForOutcome(result.outcome),
        outcome: result.outcome || 'failed',
        oldDesc: result.oldDesc != null ? result.oldDesc : item.oldDesc,
        message: result.message || '',
        errorCode: result.code || null,
        attempts: result.verify ? result.verify.attempts : null,
        shotMissing: !!result.shotMissing,
        finishedAt: now,
      });
    }
    b.updatedAt = now;
    const stopping = b.status === 'stopping' || result.outcome === 'aborted' || STOP_CODES.has(result.code);
    if (stopping) {
      skipRemaining(b, b.status === 'stopping' || result.outcome === 'aborted' ? 'Not run: stopped by operator.' : `Not run: ${result.message || 'previous tag failed'}`);
      b.status = 'stopped';
      return { batch: b, action: 'stop' };
    }
    if (nextIndex(b) >= 0) return { batch: b, action: 'next' };
    b.status = 'done';
    return { batch: b, action: 'done' };
  }

  function requestStop(batch, now = Date.now()) {
    const b = copy(batch);
    if (b.status === 'running') b.status = 'stopping';
    b.updatedAt = now;
    return b;
  }

  /** Stop when no tag is in flight (e.g. between two tags). */
  function finalizeStop(batch, message = 'Not run: stopped by operator.', now = Date.now()) {
    const b = copy(batch);
    b.items.forEach((it) => {
      if (it.status === 'running' || it.status === 'awaiting_confirm') Object.assign(it, { status: 'stopped', message });
    });
    skipRemaining(b, message);
    b.status = 'stopped';
    b.updatedAt = now;
    return b;
  }

  function summary(batch) {
    const s = { total: 0, succeeded: 0, unchanged: 0, failed: 0, skipped: 0, stopped: 0, running: 0, pending: 0 };
    (batch ? batch.items : []).forEach((it) => {
      s.total++;
      if (it.status === 'awaiting_confirm' || it.status === 'running') s.running++;
      else if (s[it.status] != null) s[it.status]++;
    });
    return s;
  }

  function isActive(batch) {
    return !!batch && (batch.status === 'running' || batch.status === 'stopping');
  }

  PTAE.batch = {
    MAX_ITEMS,
    STOP_CODES,
    normalizeItems,
    createBatch,
    nextIndex,
    startItem,
    markItem,
    applyResult,
    requestStop,
    finalizeStop,
    summary,
    isActive,
  };
})(globalThis);
