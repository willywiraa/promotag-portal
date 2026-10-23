/* History page: browse, filter, review, export and prune the amendment runs stored in IndexedDB. */
(function () {
  'use strict';
  const P = globalThis.PTAE;
  const DB = P.historyDb;
  const $ = (id) => document.getElementById(id);
  const PAGE = 50;
  const OUTCOME_LABEL = {
    success: 'Verified',
    'already-up-to-date': 'No change',
    failed: 'Failed',
    cancelled: 'Cancelled',
    aborted: 'Stopped',
    running: 'Running',
  };

  let offset = 0;
  let selectedId = null;
  const listUrls = new Set();
  const detailUrls = new Set();

  function objectUrl(blob, bucket) {
    const u = URL.createObjectURL(blob);
    bucket.add(u);
    return u;
  }

  function revoke(bucket) {
    bucket.forEach((u) => URL.revokeObjectURL(u));
    bucket.clear();
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmt(ts) {
    return ts ? new Date(ts).toLocaleString([], { hour12: false }) : '—';
  }

  function filters() {
    const from = $('from').value ? new Date(`${$('from').value}T00:00:00`).getTime() : null;
    const to = $('to').value ? new Date(`${$('to').value}T23:59:59.999`).getTime() : null;
    return { text: $('q').value.trim(), outcome: $('outcome').value || undefined, from, to };
  }

  // --- list ----------------------------------------------------------------------------------------
  async function load(reset) {
    if (reset) {
      offset = 0;
      $('rows').textContent = '';
      revoke(listUrls);
    }
    const { items, hasMore } = await DB.listRuns(Object.assign(filters(), { limit: PAGE, offset }));
    offset += items.length;
    items.forEach((run) => $('rows').append(rowFor(run)));
    $('empty').hidden = $('rows').children.length > 0;
    $('more').hidden = !hasMore;
  }

  function changeCell(run) {
    const td = el('td', 'change');
    if (run.outcome === 'already-up-to-date') {
      td.append(el('span', 'new', run.newDesc || ''), el('span', 'muted', ' (already set)'));
    } else {
      td.append(el('span', 'old', run.oldDesc != null ? run.oldDesc : '—'), el('span', 'arrow', '→'), el('span', 'new', run.newDesc || ''));
    }
    return td;
  }

  async function bestShot(run) {
    if (!run.screenshotIds || !run.screenshotIds.length) return null;
    const shots = await DB.getScreenshotsForRun(run.id);
    const pick = (kinds) => shots.filter((s) => kinds.includes(s.kind)).pop();
    return pick(['after', 'manual']) || pick(['failure']) || pick(['before']) || null;
  }

  function rowFor(run) {
    const tr = el('tr');
    tr.dataset.id = run.id;
    if (run.id === selectedId) tr.classList.add('selected');
    const outcome = el('td');
    outcome.append(el('span', `badge ${run.outcome}`, OUTCOME_LABEL[run.outcome] || run.outcome));
    const evidence = el('td');
    tr.append(el('td', 'time', fmt(run.startedAt)), el('td', 'tag', run.tagCode), changeCell(run), outcome, el('td', null, run.operator || ''), evidence);
    bestShot(run).then((shot) => {
      if (!shot || !shot.blob) {
        evidence.append(el('span', 'muted', '—'));
        return;
      }
      const img = el('img', 'mini');
      img.alt = `${shot.kind} screenshot`;
      img.src = objectUrl(shot.blob, listUrls);
      evidence.append(img);
    });
    tr.addEventListener('click', () => openDetail(run.id));
    return tr;
  }

  // --- detail --------------------------------------------------------------------------------------
  function closeDetail() {
    selectedId = null;
    $('detail').hidden = true;
    document.querySelector('.layout').classList.remove('with-detail');
    document.querySelectorAll('#rows tr.selected').forEach((tr) => tr.classList.remove('selected'));
    revoke(detailUrls);
    window.history.replaceState(null, '', location.pathname);
  }

  async function openDetail(id) {
    const run = await DB.getRun(id);
    if (!run) return;
    selectedId = id;
    document.querySelectorAll('#rows tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
    $('detail').hidden = false;
    document.querySelector('.layout').classList.add('with-detail');
    $('d-title').textContent = `Tag ${run.tagCode}`;

    const facts = $('d-facts');
    facts.textContent = '';
    const add = (k, v) => facts.append(el('dt', null, k), el('dd', null, v == null || v === '' ? '—' : String(v)));
    add('Outcome', OUTCOME_LABEL[run.outcome] || run.outcome);
    add('Old value', run.oldDesc);
    add('New value', run.newDesc);
    add(
      'Verification',
      run.verify ? `${run.verify.matched ? 'Matched' : 'Not matched'} after ${run.verify.attempts} attempt(s); grid showed "${run.verify.observed}"` : null
    );
    add('Message', run.message);
    add('Operator', run.operator);
    add('Started', fmt(run.startedAt));
    add('Finished', fmt(run.finishedAt));
    add('Backoffice', run.backofficeUrl);
    add('Raw alert', run.rawAlert);
    add('Run ID', run.id);

    revoke(detailUrls);
    const box = $('d-shots');
    box.textContent = '';
    const shots = await DB.getScreenshotsForRun(id);
    if (!shots.length) box.append(el('p', 'muted', 'No screenshots for this run.'));
    shots.forEach((shot) => {
      const fig = el('figure', 'shot');
      const img = el('img');
      img.alt = `${shot.kind} screenshot`;
      img.src = objectUrl(shot.blob, detailUrls);
      img.addEventListener('click', () => openLightbox(run, shot, img.src));
      fig.append(img, el('figcaption', null, `${shot.kind} · ${fmt(shot.takenAt)}`));
      box.append(fig);
    });

    const list = $('d-logs');
    list.textContent = '';
    (await DB.getLogs(id)).forEach((entry) => {
      const li = el('li', entry.level);
      li.append(el('time', null, new Date(entry.t).toLocaleTimeString([], { hour12: false })), document.createTextNode(entry.msg));
      list.append(li);
    });
    window.history.replaceState(null, '', `#run=${encodeURIComponent(id)}`);
  }

  function openLightbox(run, shot, src) {
    $('lb-img').src = src;
    $('lb-caption').textContent = `Tag ${run.tagCode} · ${shot.kind} · ${fmt(shot.takenAt)}`;
    const ext = shot.mime === 'image/png' ? 'png' : 'webp';
    const stamp = new Date(shot.takenAt).toISOString().replace(/[:.]/g, '-');
    $('lb-download').href = src;
    $('lb-download').download = `promotag-${run.tagCode}-${shot.kind}-${stamp}.${ext}`;
    $('lightbox').hidden = false;
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
  }

  // --- toolbar -------------------------------------------------------------------------------------
  async function usage() {
    const c = await DB.counts();
    let size = '';
    try {
      const est = await navigator.storage.estimate();
      size = ` · ${(est.usage / 1048576).toFixed(1)} MB used`;
    } catch (_) {
      /* estimate unavailable */
    }
    $('usage').textContent = `${c.runs} runs · ${c.screenshots} screenshots${size}`;
  }

  async function exportCsv() {
    const all = [];
    let off = 0;
    for (;;) {
      const { items, hasMore } = await DB.listRuns(Object.assign(filters(), { limit: 500, offset: off }));
      all.push(...items);
      off += items.length;
      if (!hasMore) break;
    }
    const blob = new Blob(['﻿' + DB.toCsv(all)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `promo-tag-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function purge() {
    const answer = window.prompt('Delete runs older than how many days?', '90');
    if (answer == null) return;
    const days = Number(answer);
    if (!Number.isFinite(days) || days < 1) {
      window.alert('Enter a number of days (1 or more).');
      return;
    }
    if (!window.confirm(`Delete every run older than ${days} days, with its log and screenshots? This cannot be undone.`)) return;
    const n = await DB.deleteRunsBefore(Date.now() - days * 86400000);
    window.alert(`${n} run(s) deleted.`);
    closeDetail();
    await load(true);
    await usage();
  }

  async function deleteSelected() {
    if (!selectedId) return;
    if (!window.confirm('Delete this run, its log and screenshots? This cannot be undone.')) return;
    await DB.deleteRun(selectedId);
    closeDetail();
    await load(true);
    await usage();
  }

  let reloadTimer = null;
  function reloadSoon(ms = 250) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      load(true);
      usage();
    }, ms);
  }

  // --- init ----------------------------------------------------------------------------------------
  async function init() {
    const { portalSession } = await chrome.storage.local.get('portalSession');
    if (!P.authCrypto.isSessionValid(portalSession)) {
      $('gate').hidden = false;
      return;
    }
    $('whoami').textContent = `Signed in as ${portalSession.userId}`;
    $('app').hidden = false;

    $('q').addEventListener('input', () => reloadSoon());
    ['outcome', 'from', 'to'].forEach((id) => $(id).addEventListener('change', () => reloadSoon()));
    $('more').addEventListener('click', () => load(false));
    $('export').addEventListener('click', exportCsv);
    $('purge').addEventListener('click', purge);
    $('d-close').addEventListener('click', closeDetail);
    $('d-delete').addEventListener('click', deleteSelected);
    $('lb-close').addEventListener('click', closeLightbox);
    $('lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox') closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.job && offset <= PAGE) reloadSoon(1000);
      if (area === 'local' && changes.portalSession && !P.authCrypto.isSessionValid(changes.portalSession.newValue)) location.reload();
    });

    await load(true);
    await usage();
    const m = location.hash.match(/run=([^&]+)/);
    if (m) openDetail(decodeURIComponent(m[1]));
  }

  $('gate-reload').addEventListener('click', () => location.reload());
  init();
})();
