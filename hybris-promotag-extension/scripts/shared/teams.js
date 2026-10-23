/*
 * Teams integration. Pure functions (needs shared/batch.js), shared by the service worker and the tests.
 *  - "Open in Promo Tag Portal" links on the Daily Alert card:
 *      <Backoffice URL>#promotags=<URL-encoded "code || description" lines>
 *  - the reply posted under the day's Daily Alert when a run finishes: one line per tag, as a
 *    Microsoft Graph chatMessage handed to the user's Power Automate workflow. Screenshots stay in History.
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});

  const LINK_PARAM = 'promotags';
  // Tag outcomes worth reporting: the tag reached Hybris. Skipped or stopped tags did not.
  const REPORTED = new Set(['succeeded', 'unchanged', 'failed']);
  const MARKS = { succeeded: '✅', unchanged: '✅ already set', failed: '❌ failed', skipped: '⏭ skipped' };

  function importLink(baseUrl, text) {
    return `${baseUrl}#${LINK_PARAM}=${encodeURIComponent(text)}`;
  }

  /** "<Backoffice URL>#promotags=…" -> { text, cleanUrl }, or null when the URL carries no tags. */
  function parseImportLink(url) {
    const s = String(url || '');
    const at = s.indexOf('#');
    if (at < 0) return null;
    const text = new URLSearchParams(s.slice(at + 1)).get(LINK_PARAM);
    if (!text || !text.trim()) return null;
    return { text, cleanUrl: s.slice(0, at) };
  }

  /** HTTP URL of the flow's "When a Teams webhook request is received" trigger. Kept verbatim (it is signed). */
  function parseWebhookUrl(raw) {
    const url = String(raw || '').trim();
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'https:' || !u.hostname) return null;
    if (/(^|\.)teams\.(microsoft\.com|cloud\.microsoft)$/i.test(u.hostname)) return null; // a Teams link, not the flow
    return { url, permission: `https://${u.hostname}/*` };
  }

  /** The flow replies under the newest channel post containing this text. */
  function matchText(batch) {
    const first = batch && batch.items[0];
    return first ? `${first.code} ||` : 'Daily Alert';
  }

  /** Worth a reply when at least one tag reached Hybris; environment failures (VPN, session) are not news. */
  function shouldPost(batch) {
    const env = PTAE.batch.STOP_CODES;
    return !!batch && batch.items.some((it) => REPORTED.has(it.status) && !(it.status === 'failed' && env.has(it.errorCode)));
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

  /** "2 FOR $82.00 → $30 OFF $199 ✅": the old value only when it is known and differs. */
  function replyText(it) {
    const change = it.oldDesc != null && it.oldDesc !== it.newDesc ? `${it.oldDesc} → ${it.newDesc}` : it.newDesc;
    return `${change} ${MARKS[it.status] || '⏭ not run'}`;
  }

  /** Graph chatMessage, one line per tag: "959  2 FOR $82.00 → $30 OFF $199 ✅". */
  function buildReply({ batch }) {
    const lines = batch.items.map((it) => `<b>${esc(it.code)}</b>&emsp;${esc(replyText(it))}`);
    return { body: { contentType: 'html', content: `<p>${lines.join('<br>')}</p>` } };
  }

  /** Request body for the workflow: where to reply (match) and what to post (message). */
  function buildPayload({ batch }) {
    return { source: 'promo-tag-portal', version: 1, match: matchText(batch), message: buildReply({ batch }) };
  }

  function buildTestPayload({ operator }) {
    const content = `<p>🧪 Promo Tag Portal test reply from ${esc(operator)}: the Teams reply works. You can delete this message.</p>`;
    return { source: 'promo-tag-portal', version: 1, test: true, match: 'Daily Alert', message: { body: { contentType: 'html', content } } };
  }

  PTAE.teams = {
    LINK_PARAM,
    importLink,
    parseImportLink,
    parseWebhookUrl,
    matchText,
    shouldPost,
    replyText,
    buildReply,
    buildPayload,
    buildTestPayload,
  };
})(globalThis);
