/*
 * Teams integration. Pure functions (needs shared/batch.js), shared by the service worker and the tests.
 *  - "Open in Promo Tag Portal" links on the Daily Alert card:
 *      <Backoffice URL>#promotags=<URL-encoded "code || description" lines>
 *  - the replies posted when a run finishes: one per tag, under that tag's Daily Alert, as a Microsoft
 *    Graph chatMessage handed to the user's Power Automate workflow, with the updated tag's screenshot
 *    as an inline image and a last line saying who ran it and when.
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

  /** A tag gets a reply when it reached Hybris; environment failures (VPN, session) are not news. */
  function isReported(it) {
    return REPORTED.has(it.status) && !(it.status === 'failed' && PTAE.batch.STOP_CODES.has(it.errorCode));
  }

  function shouldPost(batch) {
    return !!batch && batch.items.some(isReported);
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

  /** "2 FOR $82.00 → $30 OFF $199 ✅": the old value only when it is known and differs. */
  function replyText(it) {
    const change = it.oldDesc != null && it.oldDesc !== it.newDesc ? `${it.oldDesc} → ${it.newDesc}` : it.newDesc;
    return `${change} ${MARKS[it.status] || '⏭ not run'}`;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "22 Oct 2026, 15:08", in this computer's time zone (the VM's, for the VM portal). */
  function formatWhen(ms) {
    const d = new Date(ms);
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  /**
   * "Run by watsons via Promo Tag Portal · 22 Oct 2026, 15:08": the portal user who started the run, and
   * when the tag finished (so a reply sent again later keeps the time of the update).
   */
  function runLabel(batch, it) {
    const who = batch.operator ? `Run by ${batch.operator} via Promo Tag Portal` : 'Run via Promo Tag Portal';
    const at = it.finishedAt || batch.updatedAt;
    return at ? `${who} · ${formatWhen(at)}` : who;
  }

  // --- screenshots in replies: inline images of the Graph message (hostedContents) -------------------
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // larger images are left out; the reply points to History
  const SHOW_WIDTH = 600; // shown at most this wide in Teams; a click opens the full size
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
  const NO_SHOT = "<p><i>(screenshot in the portal's History)</i></p>";

  /** { width, height } of a JPEG or PNG image, or null. */
  function imageSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      return { width: u32(16), height: u32(20) }; // the IHDR chunk comes first
    }
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    // JPEG: walk the segments to the frame header (SOF0-SOF15, except DHT, JPG and DAC).
    for (let i = 2; i + 8 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }

  /** Base64 of the bytes, in chunks (btoa exists in pages, the service worker and Node). */
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /** An image Teams can show inline, or null: JPEG or PNG, at most MAX_IMAGE_BYTES. */
  function usable(image) {
    return image && image.bytes && image.bytes.length <= MAX_IMAGE_BYTES && IMAGE_TYPES.has(image.contentType) ? image : null;
  }

  /** The <img> for hosted content 1, at most SHOW_WIDTH wide. */
  function inlineImage(image, alt) {
    const size = imageSize(image.bytes);
    const w = size && size.width ? Math.min(SHOW_WIDTH, size.width) : 0;
    const dims = w ? ` width="${w}" height="${Math.round((size.height * w) / size.width)}"` : '';
    return {
      html: `<p><img src="../hostedContents/1/$value" alt="${esc(alt)}"${dims}></p>`,
      hostedContents: [{ '@microsoft.graph.temporaryId': '1', contentBytes: toBase64(image.bytes), contentType: image.contentType }],
    };
  }

  /**
   * Graph chatMessage for one tag: its line ("959  2 FOR $82.00 → $30 OFF $199 ✅"), the screenshot of
   * the updated tag, and "Run by … via Promo Tag Portal · …" from its batch (left out without one).
   * image: { bytes: Uint8Array, contentType }; null when screenshots are on but none can be sent (the
   * reply then points to History); left out for a reply without a screenshot.
   */
  function buildReply(it, image, batch) {
    const line = `<p><b>${esc(it.code)}</b>&emsp;${esc(replyText(it))}</p>`;
    const by = batch ? `<p>${esc(runLabel(batch, it))}</p>` : '';
    if (image === undefined) return { body: { contentType: 'html', content: line + by } };
    const ok = usable(image);
    if (!ok) return { body: { contentType: 'html', content: line + NO_SHOT + by } };
    const img = inlineImage(ok, `Tag ${it.code} after the update`);
    return { body: { contentType: 'html', content: line + img.html + by }, hostedContents: img.hostedContents };
  }

  /**
   * Request for the workflow for one tag of the batch: the flow replies under the newest channel post
   * containing "<code> ||" (that tag's Daily Alert), or posts a new message.
   */
  function buildPayload(it, image, batch) {
    return { source: 'promo-tag-portal', version: 1, match: `${it.code} ||`, message: buildReply(it, image, batch) };
  }

  /** One request per tag that reached Hybris, in run order. images: { [code]: image }, or none for lines only. */
  function buildPayloads({ batch, images }) {
    return batch.items.filter(isReported).map((it) => ({
      code: it.code,
      payload: buildPayload(it, images ? images[it.code] || null : undefined, batch),
    }));
  }

  /** The test reply; with a screenshot, it also shows that images arrive. */
  function buildTestPayload({ operator, image }) {
    let content = `<p>🧪 Promo Tag Portal test reply from ${esc(operator)}: the Teams reply works. You can delete this message.</p>`;
    const message = { body: { contentType: 'html', content } };
    const ok = usable(image);
    if (ok) {
      const img = inlineImage(ok, 'Latest screenshot');
      content += `<p>The latest screenshot, to check that screenshots arrive:</p>${img.html}`;
      Object.assign(message, { body: { contentType: 'html', content }, hostedContents: img.hostedContents });
    }
    return { source: 'promo-tag-portal', version: 1, test: true, match: 'Daily Alert', message };
  }

  PTAE.teams = {
    LINK_PARAM,
    importLink,
    parseImportLink,
    parseWebhookUrl,
    isReported,
    shouldPost,
    replyText,
    formatWhen,
    runLabel,
    imageSize,
    toBase64,
    buildReply,
    buildPayload,
    buildPayloads,
    buildTestPayload,
    MAX_IMAGE_BYTES,
  };
})(globalThis);
