/*
 * Two-tier selector registry (PRD §4) + resolver, and the CONFIG tuning surface.
 *
 * Tier 1 (primary): resilient functional attributes — ARIA, placeholders, titles, ZK classes, text.
 * Tier 2 (fallback): the sample IDs from the PRD. They belong to one ZK session, so a fallback hit
 *                    is only accepted when it passes the entry's semantic `validate` check.
 *
 * If the real Backoffice differs (labels, button captions), adjust CONFIG below — the run log
 * lists the visible labels/buttons whenever an element cannot be found.
 */
(function (root) {
  'use strict';
  const PTAE = (root.PTAE = root.PTAE || {});
  const D = PTAE.dom;

  const CONFIG = {
    roleName: 'WTCSG Backoffice User Role',
    promotionTagLabel: 'Promotion Tag',
    // Typed into "Filter tree". Backoffice opens the folders above a match but shows a match itself
    // closed, so a broader text such as "promotion" leaves Promotion Tag hidden in the "Promotions" folder.
    treeFilterText: 'Promotion Tag',
    // Tree folders above Promotion Tag, outermost first; opened only if the filter leaves one closed.
    promotionTagParents: ['Marketing', 'Promotions'],
    treeSettleMs: 1200, // the tree counts as settled after this long without changes
    treeOpenTries: 4, // per folder: a later filter pass can close it again
    tagCodeLabels: ['Tag Code'],
    codeColumnHeaders: ['Tag Code', 'Code'],
    descriptionLabels: ['Tag', 'Tag Description', 'Description'],
    roleConfirmButtons: ['Proceed', 'OK', 'Continue', 'Select', 'Confirm', 'Login', 'Log In', 'Sign In', 'Submit', 'Apply', 'Enter'],
    searchButtons: ['Search'],
    saveButtons: ['Save'],
    // Used to throw away an unsaved edit after a failure, so the next tag in a run starts clean.
    discardButtons: ['Cancel', 'Discard', 'Discard changes', 'Reset', 'Undo', 'Revert'],
    successToast: /\b(saved|success(?:ful(?:ly)?)?|updated)\b/i,
    budgets: { default: 8000, shell: 60000, navigate: 30000, manualLogin: 180000, search: 20000, save: 15000, confirm: 600000, idle: 15000 },
    poll: { interval: 300, factor: 1.5, maxInterval: 2400 },
    verify: { cooldownsMs: [3000, 5000, 8000] }, // initial check + 3 retries
    maxSsoAttempts: 2,
    auStallMs: 20000,
  };

  const EDITOR_AREA = '[class*="editorarea" i], [class*="editor-area" i]';

  // --- helpers -------------------------------------------------------------------------------------
  function strategy(name, fn) {
    return { name, fn };
  }

  function css(selector, opts) {
    return strategy(selector + (opts && opts.text ? ' + text' : ''), (ctx) => {
      const o = Object.assign({}, opts);
      if (typeof o.text === 'function') o.text = o.text(ctx);
      return D.findFirst(selector, o);
    });
  }

  function rowCells(tr) {
    return tr ? Array.from(tr.cells || tr.querySelectorAll('td')) : [];
  }

  function editorRoots() {
    return D.findAll(EDITOR_AREA, { visibleOnly: false });
  }

  function lcaDepth(a, b) {
    const depth = new Map();
    let d = 0;
    for (let n = a; n; n = n.parentNode) depth.set(n, d++);
    for (let n = b; n; n = n.parentNode) if (depth.has(n)) return d - depth.get(n);
    return -1;
  }

  /** Visible, enabled button whose text/title/aria-label matches; the one closest to `anchor` wins. */
  function nearestButton(anchor, texts, opts = {}) {
    const ok = (b) =>
      !D.isDisabled(b) &&
      texts.some((t) => D.eqi(D.textOf(b), t) || D.eqi(b.getAttribute('title') || '', t) || D.eqi(b.getAttribute('aria-label') || '', t));
    const all = D.findAll('button, [role="button"], .z-button', { root: opts.root, exclude: opts.exclude }).filter(ok);
    if (!all.length || !anchor) return all[0] || null;
    let best = null;
    let bestDepth = -1;
    for (const b of all) {
      const d = lcaDepth(anchor, b);
      if (d > bestDepth) {
        best = b;
        bestDepth = d;
      }
    }
    return best;
  }

  /** "Tag Code" search field: prefer labels between the search toggle and the result list, never inside an editor area. */
  function searchCodeInput(ctx) {
    const exclude = editorRoots();
    const toggle = D.findFirst('button.yw-toggle-advanced-search, button[title="Switch search mode"]');
    const list = D.findAll('tr.z-listitem').find((tr) => tr.querySelector('.yw-listview-cell-label'));
    const labels = D.findLabelElements(ctx.cfg.tagCodeLabels, { exclude });
    const preferred = labels.filter((l) => (!toggle || D.follows(toggle, l)) && (!list || D.follows(l, list)));
    const opts = { exclude, stopLabels: ctx.cfg.descriptionLabels };
    for (const l of preferred.concat(labels.filter((l) => !preferred.includes(l)))) {
      const hit = D.inputForLabel(l, opts);
      if (hit) return hit.input;
    }
    return null;
  }

  /** Areas that must never be mistaken for the record editor: search panel, result list, explorer tree. */
  function nonEditorAreas(ctx) {
    return [ctx.searchPanel || ctx.searchRow, ctx.listbox].concat(D.findAll('.z-tree', { visibleOnly: false })).filter(Boolean);
  }

  /** Label lookup that prefers a recognisable editor area and falls back to the whole page. */
  function inputInEditor(labels, stopLabels, ctx) {
    const opts = { exclude: nonEditorAreas(ctx), stopLabels };
    for (const root of editorRoots().filter(D.isVisible)) {
      const hit = D.findInputByLabel(labels, Object.assign({ root }, opts));
      if (hit) return hit;
    }
    return D.findInputByLabel(labels, opts);
  }

  /** Description field in the record editor. */
  function descriptionByLabel(ctx) {
    const hit = inputInEditor(ctx.cfg.descriptionLabels, ctx.cfg.tagCodeLabels, ctx);
    return hit && hit.input;
  }

  // --- registry ------------------------------------------------------------------------------------
  const REGISTRY = {
    ssoLink: {
      step: 1,
      description: 'SSO login link',
      primary: [
        css('a[href*="samlsinglesignon/saml/backoffice"]'),
        css('a.z-a', { text: { equals: 'Login with Single Sign On' } }),
      ],
      fallback: ['#lQ3In'],
      validate: (el) => el.tagName === 'A',
    },

    loginForm: {
      description: 'Backoffice username/password form',
      primary: [css('input[type="password"]')],
      fallback: [],
      validate: (el) => el.tagName === 'INPUT',
    },

    roleRow: {
      step: 2,
      description: 'Backoffice user role row',
      primary: [
        strategy('tr[aria-label*="<role>"]', (ctx) =>
          D.findAll('tr[aria-label]').find((tr) =>
            D.normText(tr.getAttribute('aria-label')).toLowerCase().includes(D.normText(ctx.roleName).toLowerCase())
          ) || null
        ),
        css('tr.yw-selector-listitem', { text: (ctx) => ({ includes: ctx.roleName }) }),
      ],
      fallback: ['#rCbVtc2'],
      validate: (el, ctx) => el.tagName === 'TR' && D.textOf(el).toLowerCase().includes(D.normText(ctx.roleName).toLowerCase()),
    },

    roleConfirmButton: {
      description: 'Role selection confirm button',
      primary: [
        strategy('confirm button in role dialog', (ctx) => {
          const row = ctx.roleRowEl;
          const scope = row && row.closest('.z-window, .z-window-modal, .z-window-embedded, [role="dialog"]');
          return nearestButton(row || null, ctx.cfg.roleConfirmButtons, { root: scope || undefined });
        }),
      ],
      fallback: [],
      validate: (el) => !D.isDisabled(el),
    },

    treeFilter: {
      step: 3,
      description: 'Explorer tree filter',
      primary: [
        css('input.z-bandbox-input[placeholder*="Filter tree"]'),
        css('input[id$="-real"][placeholder*="Filter tree"]'),
      ],
      fallback: ['#s88Ryb-real'],
      validate: (el) => D.isTextInput(el),
    },

    promotionTagNode: {
      step: 4,
      description: 'Promotion Tag tree node',
      primary: [
        css('.z-tree span.z-label, .z-treerow span.z-label', { text: (ctx) => ({ equals: ctx.cfg.promotionTagLabel }) }),
        css('div.z-treecell-content', { text: (ctx) => ({ equals: ctx.cfg.promotionTagLabel }) }),
      ],
      fallback: ['#s88Rhr6'],
      validate: (el, ctx) =>
        D.eqi(D.textOf(el), ctx.cfg.promotionTagLabel) && !!el.closest('tr, [role="treeitem"], .z-tree'),
    },

    searchModeToggle: {
      step: 5,
      description: 'Advanced search toggle',
      primary: [css('button.yw-toggle-advanced-search'), css('button[title="Switch search mode"]')],
      fallback: ['#s88Ryh'],
      validate: (el) => el.tagName === 'BUTTON',
    },

    tagCodeInput: {
      step: 6,
      description: 'Tag Code search field',
      primary: [
        strategy('label "Tag Code" → nearest input (search panel)', searchCodeInput),
        strategy('[aria-label*="Tag Code"] input', () =>
          D.findAll('[aria-label*="Tag Code"] input.z-textbox, [aria-label*="Tag Code"] input.ye-input-text, input[aria-label*="Tag Code"]', {
            exclude: editorRoots(),
          })[0] || null
        ),
      ],
      fallback: ['#s88Rl67'],
      validate: (el) => D.isTextInput(el) && !el.disabled && !el.closest(EDITOR_AREA),
    },

    searchButton: {
      description: 'Advanced search "Search" button',
      primary: [
        strategy('button "Search" nearest the Tag Code field', (ctx) =>
          nearestButton(ctx.searchInput || null, ctx.cfg.searchButtons, { exclude: editorRoots() })
        ),
      ],
      fallback: [],
      validate: (el) => !D.isDisabled(el),
    },

    resultRows: {
      step: 7,
      multi: true,
      description: 'Search result rows',
      primary: [
        strategy('tr.z-listitem with .yw-listview-cell-label', () =>
          D.findAll('tr.z-listitem').filter((tr) => tr.querySelector('.yw-listview-cell-label'))
        ),
      ],
      fallback: ['#s88R_da-cave', '#s88R0da'],
      fallbackClosest: 'tr',
      validate: (tr) => tr.tagName === 'TR' && !tr.closest('.z-tree'),
      // A fallback row is only trusted when one of its cells shows exactly the Tag Code.
      validateFallback: (tr, ctx) =>
        tr.tagName === 'TR' && rowCells(tr).some((td) => D.eqi(D.textOf(td), ctx.code || '')),
    },

    descInput: {
      step: 8,
      description: 'Tag description field (editor area)',
      primary: [
        strategy('label (Tag / Tag Description / Description) → nearest input', descriptionByLabel),
        strategy('[aria-label="Tag"] input', (ctx) =>
          D.findAll('div[aria-label="Tag"] input, [aria-label="Tag Description"] input, input[aria-label="Tag"]', {
            exclude: nonEditorAreas(ctx),
          })[0] || null
        ),
      ],
      fallback: ['#s88R7ea'],
      validate: (el, ctx) => D.isEditable(el) && !nonEditorAreas(ctx).some((area) => area.contains(el)),
    },

    saveButton: {
      step: 9,
      description: 'Save button',
      primary: [
        strategy('button "Save" nearest the description field', (ctx) =>
          nearestButton(ctx.descEl || null, ctx.cfg.saveButtons)
        ),
        css('button[title="Save"]'),
      ],
      fallback: ['button.y-btn-primary'],
      validate: (el, ctx) =>
        !D.isDisabled(el) &&
        ctx.cfg.saveButtons.some((t) => D.eqi(D.textOf(el), t) || D.eqi(el.getAttribute('title') || '', t)),
    },

    verifyCell: {
      step: 12,
      description: 'Result grid description cell',
      primary: [
        strategy('cell label in the remembered description column', (ctx) => {
          if (!ctx.row || !(ctx.descColumn >= 0)) return null;
          const cell = rowCells(ctx.row)[ctx.descColumn];
          return cell ? cell.querySelector('.yw-listview-cell-label') || cell : null;
        }),
      ],
      fallback: ['#s88Rsza'],
      validate: (el, ctx) => !!ctx.row && ctx.row.contains(el),
    },
  };

  // --- resolver ------------------------------------------------------------------------------------
  function safe(fn) {
    try {
      return fn();
    } catch (_) {
      return null;
    }
  }

  /**
   * @returns {{el: Element, els?: Element[], tier: 'primary'|'fallback', strategy: string, key: string}|null}
   */
  function resolve(key, ctx = {}, opts = {}) {
    const entry = REGISTRY[key];
    if (!entry) throw new Error(`Unknown selector key: ${key}`);
    const tiers = opts.tiers || ['primary', 'fallback'];
    const c = Object.assign({ cfg: CONFIG, roleName: CONFIG.roleName }, ctx);
    const ok = (el) => !!el && (!entry.validate || !!safe(() => entry.validate(el, c)));
    const okFallback = (el) => !!el && !!safe(() => (entry.validateFallback || entry.validate || (() => true))(el, c));

    if (entry.multi) {
      if (tiers.includes('primary')) {
        for (const s of entry.primary) {
          const els = (safe(() => s.fn(c)) || []).filter(ok);
          if (els.length) return { el: els[0], els, tier: 'primary', strategy: s.name, key };
        }
      }
      if (tiers.includes('fallback')) {
        for (const sel of entry.fallback) {
          const els = D.findAll(sel)
            .map((x) => (entry.fallbackClosest ? x.closest(entry.fallbackClosest) : x))
            .filter((x, i, arr) => x && arr.indexOf(x) === i && ok(x) && okFallback(x));
          if (els.length) return { el: els[0], els, tier: 'fallback', strategy: sel, key };
        }
      }
      return null;
    }

    if (tiers.includes('primary')) {
      for (const s of entry.primary) {
        const el = safe(() => s.fn(c));
        if (ok(el)) return { el, tier: 'primary', strategy: s.name, key };
      }
    }
    if (tiers.includes('fallback')) {
      for (const sel of entry.fallback) {
        const el = D.findAll(sel).find(okFallback);
        if (el) return { el, tier: 'fallback', strategy: sel, key };
      }
    }
    return null;
  }

  /** Header captions of the listbox that holds `row` (index-aligned with its cells). */
  function headerTexts(row) {
    const box = row && row.closest('.z-listbox');
    if (!box) return [];
    return D.qsa('th.z-listheader', box).map((th) => D.textOf(th));
  }

  /**
   * Picks the result row for `code`: exact match in the Tag Code/Code column, else any cell equal
   * to the code, else a lone row (flagged exact:false, needs editor verification).
   */
  function pickRow(rows, code, cfg = CONFIG) {
    const data = rows.map((tr) => ({ tr, cells: rowCells(tr).map((td) => D.textOf(td)) }));
    const headers = rows.length ? headerTexts(rows[0]) : [];
    const codeIdx = headers.findIndex((h) => cfg.codeColumnHeaders.some((c) => D.eqi(h, c)));
    const same = (a) => D.normText(a) === D.normText(code);
    let matches = codeIdx >= 0 ? data.filter((r) => same(r.cells[codeIdx] || '')) : [];
    if (!matches.length) matches = data.filter((r) => r.cells.some(same));
    if (matches.length === 1) {
      const m = matches[0];
      const idx = codeIdx >= 0 && same(m.cells[codeIdx] || '') ? codeIdx : m.cells.findIndex(same);
      return { row: m.tr, exact: true, codeIndex: idx, cells: m.cells };
    }
    if (matches.length > 1) return { error: 'ambiguous', count: matches.length };
    if (data.length === 1) return { row: data[0].tr, exact: false, codeIndex: -1, cells: data[0].cells };
    return { error: 'no-exact', count: data.length };
  }

  PTAE.CONFIG = CONFIG;
  PTAE.SELECTORS = REGISTRY;
  PTAE.resolve = resolve;
  PTAE.pickRow = pickRow;
  PTAE.sel = { rowCells, headerTexts, nearestButton, editorRoots, nonEditorAreas, inputInEditor, EDITOR_AREA };
})(globalThis);
