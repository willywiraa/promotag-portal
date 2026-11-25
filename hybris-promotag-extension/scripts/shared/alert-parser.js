/*
 * DAILY_ALERT payload parser.
 *   "885 || 10% OFF $70"               -> { code: "885", desc: "10% OFF $70" }
 *   "895 || to change to 10% OFF $70"  -> { code: "895", desc: "10% OFF $70" }
 * Pure functions: shared by the popup and the tests.
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});

  const SPACE_LIKE = /[   -   　]/g;
  const ZERO_WIDTH = /[​-‍﻿]/g;
  // "(to) change(d) to", "update(d) to", "amend(ed) to", optionally followed by ":" or a dash.
  const INSTRUCTION = /(?:\bto\s+)?\b(?:change|changed|update|updated|amend|amended)\s+to\b\s*[:\-–—]?\s*/gi;
  const QUOTES = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  const CODE_RE = /^\d{1,64}$/; // promo tag codes are always numbers

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(ZERO_WIDTH, '')
      .replace(SPACE_LIKE, ' ')
      .replace(/\r\n?/g, '\n');
  }

  /** Returns the text after the last instruction phrase ("to change to …"), or the input unchanged. */
  function stripInstruction(desc) {
    let end = -1;
    let m;
    INSTRUCTION.lastIndex = 0;
    while ((m = INSTRUCTION.exec(desc)) !== null) {
      end = m.index + m[0].length;
      if (m[0].length === 0) INSTRUCTION.lastIndex++;
    }
    return end >= 0 ? desc.slice(end) : desc;
  }

  function unquote(s) {
    for (const [open, close] of QUOTES) {
      if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) return s.slice(1, -1).trim();
    }
    return s;
  }

  function cleanCode(token) {
    return String(token || '').replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '');
  }

  function validateCode(code) {
    if (!code) return 'Tag Code is required.';
    if (!CODE_RE.test(code)) return 'Tag Code must be a number (digits only).';
    return null;
  }

  function validateDesc(desc) {
    if (!desc || !String(desc).trim()) return 'New Tag Description is required.';
    return null;
  }

  /**
   * @param {string} raw  pasted alert text (may span several lines)
   * @returns {{code: string, desc: string, hasDelimiter: boolean, warnings: string[], error: string|null}}
   */
  function parseAlert(raw) {
    const out = { code: '', desc: '', hasDelimiter: false, warnings: [], error: null };
    const lines = normalize(raw).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      out.error = 'Alert text is empty.';
      return out;
    }

    const line = lines.find((l) => l.includes('||'));
    if (!line) {
      if (lines.length > 1) out.warnings.push('No "||" found; using the first line as the Tag Code.');
      const tokens = lines[0].split(/\s+/);
      out.code = cleanCode(tokens[tokens.length - 1]);
      out.error = validateCode(out.code);
      return out;
    }

    out.hasDelimiter = true;
    const at = line.indexOf('||');
    const tokens = line.slice(0, at).trim().split(/\s+/).filter(Boolean);
    const fields = line.slice(at + 2).split('||');
    if (fields.length > 1) out.warnings.push('Alert has more than two "||" fields; only the second field is used.');

    out.code = tokens.length ? cleanCode(tokens[tokens.length - 1]) : '';
    out.desc = unquote(stripInstruction(fields[0]).trim());
    out.error = validateCode(out.code) || validateDesc(out.desc);
    return out;
  }

  /**
   * Every "code || description" line in a pasted alert, e.g. a whole Teams Daily Alert card:
   *   Record 1 / Alert_Datetime … / Alert_Message 888 || 3 FOR $16.65 / Record 2 / …
   * Lines without "||" are ignored. Lines whose code has letters are other Daily Alerts
   * ("MT || Count: 0", "TLOG || Count: 98"): they go to `skipped`, not to the tags.
   * A code listed twice keeps its last description (with a warning). `at` is the record's Alert_Datetime
   * when the card shows one (it tells the cards apart for the Teams reply), otherwise ''.
   * @returns {{items: {code: string, desc: string, line: string, at: string}[], errors: string[], warnings: string[], skipped: string[]}}
   */
  function parseAlerts(raw) {
    const out = { items: [], errors: [], warnings: [], skipped: [] };
    const all = normalize(raw).split('\n').map((l) => l.trim()).filter(Boolean);
    let at = '';
    for (const [i, line] of all.entries()) {
      if (/^Record\s+\d+$/i.test(line)) at = '';
      const when = /^Alert_Datetime(?:\s*:)?(?:\s+(.*))?$/i.exec(line);
      if (when) at = (when[1] || (all[i + 1] && !all[i + 1].includes('||') ? all[i + 1] : '')).replace(/\s+/g, ' ');
      if (!line.includes('||')) continue;
      const r = parseAlert(line);
      if (isOtherAlert(r)) {
        out.skipped.push(line);
        continue;
      }
      if (r.error) {
        out.errors.push(`"${line}": ${r.error}`);
        continue;
      }
      const existing = out.items.find((it) => it.code === r.code);
      if (existing) {
        if (existing.desc !== r.desc) out.warnings.push(`Tag ${r.code} appears more than once; using "${r.desc}".`);
        existing.desc = r.desc;
        existing.line = line;
        existing.at = at;
      } else {
        out.items.push({ code: r.code, desc: r.desc, line, at });
      }
      r.warnings.forEach((w) => out.warnings.push(w));
    }
    return out;
  }

  /** A "word || text" line whose word has letters: an alert about something other than a promo tag. */
  function isOtherAlert(r) {
    return r.hasDelimiter && /[A-Za-z]/.test(r.code);
  }

  /** "2 other alerts skipped (not promo tags): MT || Count: 0, TLOG || Count: 98.", or '' for none. */
  function skippedNote(lines) {
    if (!lines || !lines.length) return '';
    const shown = lines.slice(0, 3).map((l) => l.replace(/^Alert_Message\s+/i, ''));
    const more = lines.length > 3 ? `, and ${lines.length - 3} more` : '';
    return `${lines.length} other alert${lines.length === 1 ? '' : 's'} skipped (not promo tags): ${shown.join(', ')}${more}.`;
  }

  PTAE.parser = { parseAlert, parseAlerts, isOtherAlert, skippedNote, validateCode, validateDesc, stripInstruction, normalize };
})(globalThis);
