/*
 * Scripted mock of the ZK Backoffice for pipeline tests. Load BEFORE zk-bridge.js.
 * - Every user action becomes a simulated AU round trip (FakeXHR to /backoffice/zkau), so the
 *   bridge's response counter and busy state behave as on the real system.
 * - The server-side model only changes through ZK widget events (onChanging/onChange/onOK) or
 *   clicks, so a value typed without a real onChange never reaches the "server".
 * - IDs are regenerated on every render, like ZK.
 */
(function () {
  'use strict';

  let pendingAu = 0;

  class FakeXHR extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this.responseURL = '';
    }
    open(method, url) {
      this._url = url;
      this.readyState = 1;
    }
    setRequestHeader() {}
    send() {
      setTimeout(() => {
        const down = M.networkDown;
        this.readyState = 4;
        this.status = down ? 0 : 200;
        this.responseURL = down ? '' : new URL(this._url, location.href).href;
        this.dispatchEvent(new Event(down ? 'error' : 'load'));
        this.dispatchEvent(new Event('loadend'));
      }, this.latency != null ? this.latency : M.latency);
    }
    abort() {}
  }
  window.XMLHttpRequest = FakeXHR;

  /** One AU round trip: the server applies `apply` when the response arrives (if the network is up). */
  function au(apply, latency) {
    pendingAu++;
    const xhr = new XMLHttpRequest();
    xhr.latency = latency;
    xhr.open('POST', '/backoffice/zkau');
    xhr.addEventListener('loadend', () => {
      pendingAu--;
      if (xhr.status === 200 && apply) apply();
    });
    xhr.send('cmd_0=onEvent');
  }

  window.zAu = { processing: () => pendingAu > 0 };

  // --- ZK widget stubs ---------------------------------------------------------------------------
  /** Tree rows answer like ZK: the row's widget sits in a Treeitem that can be opened (onOpen to the server). */
  function treeWidgetFor(row) {
    const label = row.dataset.label;
    const tree = { widgetName: 'tree', parent: null };
    const item = {
      widgetName: 'treeitem',
      parent: tree,
      isOpen: () => row.dataset.open === 'true',
      setOpen(open) {
        M.log.push(`tree-open:${label}`);
        setFolder(label, open);
      },
    };
    return { widgetName: 'treerow', parent: item };
  }

  function widgetFor(el) {
    const row = el && el.closest && el.closest('tr.z-treerow');
    if (row) return M.zkTreeApi ? treeWidgetFor(row) : null;
    const input = el && el.matches && el.matches('input') ? el : null;
    if (!input) return null;
    if (!input.__w) {
      input.__w = {
        widgetName: 'textbox',
        parent: null,
        setValue(v) { input.value = v; },
        getInputNode() { return input; },
        fireOnChange() { serverChange(input, input.value); },
        fire(name, data) {
          if (name === 'onChanging' || name === 'onChange') serverChange(input, data && data.value != null ? data.value : input.value);
          if (name === 'onOK') serverOk(input);
        },
        isListen(name) { return name === 'onOK' && input.dataset.role === 'tagcode'; },
      };
    }
    return input.__w;
  }
  window.zk = { version: 'mock', Widget: { $: widgetFor } };

  // --- model -------------------------------------------------------------------------------------
  const M = (window.MockBackoffice = {
    latency: 120,
    timers: [],
    networkDown: false,
    staleSearches: 0,
    neverReflect: false,
    saveFails: null,
    records: [],
    state: {},
    log: [],
    reset,
  });

  const zid = () => 'm' + Math.random().toString(36).slice(2, 7);
  const app = () => document.getElementById('app');
  const $r = (role) => document.querySelector(`[data-role="${role}"]`);

  function reset(opts = {}) {
    clearInterval(M.pollTimer);
    (M.timers || []).forEach(clearTimeout);
    M.timers = [];
    M.latency = opts.latency || 120;
    M.filterLatency = opts.filterLatency || null; // a slow tree filter
    M.filterMode = opts.filterMode || 'substring'; // 'anyWord': a node matches when it contains any typed word
    M.latePasses = opts.latePasses || []; // ms after the session's first filter at which Backoffice filters again
    M.openLatency = opts.openLatency || null; // a slow folder open
    M.zkTreeApi = opts.zkTreeApi !== false; // tree rows are ZK widgets (Treeitem.setOpen)
    M.expanderIgnored = !!opts.expanderIgnored; // a synthetic click on an expander does nothing
    M.networkDown = !!opts.networkDown;
    M.staleSearches = opts.staleSearches || 0;
    M.neverReflect = !!opts.neverReflect;
    M.saveFails = opts.saveFails || null;
    M.records = (opts.records || [{ code: '895', desc: '10% OFF $80' }]).map((r) => Object.assign({ prevDesc: null }, r));
    M.log = [];
    M.state = {
      page: opts.page || 'shell',
      roleSelected: false,
      typeOpen: !!opts.typeOpen,
      searchOpen: !!opts.searchOpen,
      searchCode: '',
      results: [],
      selected: null,
      dirty: null,
      staleLeft: 0,
    };
    // Explorer tree: the filter text, the folders opened by hand since the last filter pass, and
    // whether this session has filtered before. `treeFiltered` starts on a tree filtered down to
    // Promotion Tag (a later tag in a run); `treeOpen` lists folders already open.
    M.tree = { filter: opts.treeFiltered ? 'Promotion Tag' : '', open: new Set(opts.treeOpen || []), filtered: !!opts.treeFiltered };
    app().innerHTML = '';
    renderAll();
    // The Home dashboard refreshes its live figures in the background (AU traffic unrelated to the tree).
    if (opts.dashboardRefresh) M.pollTimer = setInterval(() => au(null, opts.dashboardRefresh.latency), opts.dashboardRefresh.every);
  }

  function later(fn, ms) {
    M.timers.push(setTimeout(fn, ms));
  }

  // --- rendering ---------------------------------------------------------------------------------
  function renderAll() {
    const s = M.state;
    if (s.page === 'login') {
      app().innerHTML = window.PTAEFixtures.loginPage();
      return;
    }
    if (s.page === 'role') {
      app().innerHTML = window.PTAEFixtures.rolePage({ roleSelected: false });
      return;
    }
    if (!app().querySelector('.yw-shell')) app().innerHTML = shellSkeleton();
    renderTree();
    renderBrowser();
    renderResults();
    renderEditor();
  }

  function shellSkeleton() {
    return `
      <div class="yw-shell" style="display:flex;gap:16px">
        <div class="yw-explorer" style="width:220px">
          <span class="z-bandbox"><input id="${zid()}-real" class="z-bandbox-input" data-role="filter" type="text" placeholder="Filter tree (Alt+Down for options)"></span>
          <div class="z-tree"><table><tbody id="tree-body"></tbody></table></div>
        </div>
        <div class="yw-workspace" style="flex:1">
          <div class="yw-collectionbrowser" id="browser">
            <div class="yw-searchbar">
              <input class="z-textbox" type="text" placeholder="Search">
              <button type="button" id="${zid()}" class="yw-toggle-advanced-search yw-toggle-closed z-button" title="Switch search mode" data-role="toggle"></button>
            </div>
            <div class="yw-advancedsearch" id="adv">
              <table><tbody>
                <tr><td><span class="z-label">Tag Code</span></td><td><span class="z-combobox"><input class="z-combobox-input" value="contains"></span></td>
                  <td><input id="${zid()}" class="ye-input-text ye-com_hybris_cockpitng_editor_defaulttext z-textbox" data-role="tagcode" type="text"></td></tr>
                <tr><td><span class="z-label">Tag</span></td><td><span class="z-combobox"><input class="z-combobox-input" value="contains"></span></td>
                  <td><input id="${zid()}" class="ye-input-text ye-com_hybris_cockpitng_editor_defaulttext z-textbox" data-role="search-tag" type="text"></td></tr>
              </tbody></table>
              <button type="button" class="z-button" data-role="search">Search</button>
            </div>
            <div class="z-listbox yw-listview">
              <div class="z-listbox-header"><table><thead><tr class="z-listhead">
                <th class="z-listheader">Tag Code</th><th class="z-listheader">Tag</th>
              </tr></thead></table></div>
              <div class="z-listbox-body"><table><tbody id="results"></tbody></table></div>
            </div>
          </div>
          <div id="editor"></div>
          <div id="toasts"></div>
        </div>
      </div>`;
  }

  // The part of the real explorer tree that matters (labels as in the real Backoffice).
  const TREE = [
    { label: 'Home' },
    { label: 'System', children: [{ label: 'Types' }, { label: 'Users' }] },
    { label: 'Catalog', children: [{ label: 'Catalogs' }, { label: 'Products' }] },
    {
      label: 'Marketing',
      children: [
        { label: 'Promotion Website Groups' }, { label: 'Promotion Rules' }, { label: 'Promotion Templates' },
        { label: 'Promotion Modules' }, { label: 'Promotion Rule Groups' },
        { label: 'Promotions', children: [{ label: 'Promotion Tag' }, { label: 'Promotion Tag Group' }, { label: 'Promotion Source Rules' }] },
        { label: 'Promotion Planning' }, { label: 'Bankday Promotion' }, { label: 'Vip Promotion' }, { label: 'Vip Campaign Promotion' },
      ],
    },
    { label: 'Saved queries', always: true },
  ];

  /**
   * The rows the tree shows. Like Backoffice: without a filter, folders are closed unless opened by
   * hand. With a filter, a node whose label matches is shown closed (so "promotion" leaves the
   * "Promotions" folder closed, with Promotion Tag hidden inside), and folders above a match are
   * opened by the filter itself.
   */
  function treeRows() {
    const f = M.tree.filter.trim().toLowerCase();
    const words = f.split(/\s+/).filter(Boolean);
    const matches = (n) => !!f && (M.filterMode === 'anyWord' ? words.some((w) => n.label.toLowerCase().includes(w)) : n.label.toLowerCase().includes(f));
    const below = (n) => (n.children || []).some((c) => matches(c) || below(c));
    const rows = [];
    (function walk(nodes, depth, all) {
      for (const n of nodes) {
        let open;
        if (!f || all || n.always || matches(n)) open = M.tree.open.has(n.label);
        else if (below(n)) open = true;
        else continue;
        rows.push({ label: n.label, depth, folder: !!n.children, open: !!n.children && open });
        if (n.children && open) walk(n.children, depth + 1, !f || all || matches(n));
      }
    })(TREE, 0, false);
    return rows;
  }

  function renderTree() {
    const s = M.state;
    // Like ZK, a folder row has an expander (caret right = closed, down = open). IDs change on every render.
    document.getElementById('tree-body').innerHTML = treeRows()
      .map((r) => {
        const sel = r.label === 'Promotion Tag' && s.typeOpen;
        const icon = r.folder ? `<span id="${zid()}-open" class="z-tree-icon"><i class="z-icon-caret-${r.open ? 'down' : 'right'}"></i></span>` : '';
        return `<tr id="${zid()}" class="z-treerow${sel ? ' z-treerow-selected' : ''}" aria-selected="${sel}" data-label="${r.label}" data-open="${r.open}">
          <td class="z-treecell"><div class="z-treecell-content" style="padding-left:${r.depth * 16}px">${icon}<span id="${zid()}" class="z-label">${r.label}</span></div></td></tr>`;
      })
      .join('');
  }

  /** A filter pass rebuilds the tree: folders opened by hand close again. */
  function applyFilter(value) {
    M.tree.filter = value;
    M.tree.open = new Set();
    M.log.push(`tree-filter:${value}`);
    renderTree();
  }

  /** Opens or closes a folder (one AU round trip). */
  function setFolder(label, open) {
    au(() => {
      const isOpen = treeRows().some((r) => r.label === label && r.open);
      const want = open == null ? !isOpen : !!open;
      if (want) M.tree.open.add(label);
      else M.tree.open.delete(label);
      renderTree();
    }, M.openLatency);
  }

  function renderBrowser() {
    const s = M.state;
    document.getElementById('browser').style.display = s.typeOpen ? '' : 'none';
    const toggle = $r('toggle');
    toggle.classList.toggle('yw-toggle-closed', !s.searchOpen);
    toggle.classList.toggle('yw-toggle-open', s.searchOpen);
    document.getElementById('adv').style.display = s.searchOpen ? '' : 'none';
  }

  function renderResults() {
    const body = document.getElementById('results');
    if (!body) return;
    body.innerHTML = M.state.results
      .map((r) => `<tr id="${zid()}" class="z-listitem${r.code === M.state.selected ? ' z-listitem-selected' : ''}" data-code="${r.code}">
        <td class="z-listcell"><div class="z-listcell-content"><span id="${zid()}" class="yw-listview-cell-label z-label">${r.code}</span></div></td>
        <td class="z-listcell"><div id="${zid()}-cave" class="z-listcell-content"><span id="${zid()}" class="yw-listview-cell-label z-label">${r.desc}</span></div></td></tr>`)
      .join('');
  }

  function renderEditor() {
    const box = document.getElementById('editor');
    if (!box) return;
    const rec = M.records.find((r) => r.code === M.state.selected);
    if (!rec) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="yw-editorarea-container">
        <div class="yw-editorarea-section-caption z-label">Essential</div>
        <div class="yw-editorarea-attrcell"><span class="z-label">Tag Code</span>
          <input id="${zid()}" class="ye-input-text z-textbox" value="${rec.code}" readonly aria-readonly="true"></div>
        <div class="yw-editorarea-attrcell"><span class="z-label">Tag</span>
          <input id="${zid()}" class="ye-input-text ye-com_hybris_cockpitng_editor_defaulttext z-textbox" data-role="desc" type="text" value="${rec.desc}"></div>
        <button type="button" class="y-btn-primary z-button" data-role="save" ${M.state.dirty == null ? 'disabled' : ''}>Save</button>
      </div>`;
  }

  function toast(text) {
    const div = document.createElement('div');
    div.className = 'yw-notification yw-notification-success';
    div.textContent = text;
    document.getElementById('toasts').append(div);
    setTimeout(() => div.remove(), 4000);
  }

  // --- "server" ----------------------------------------------------------------------------------
  function serverSearch() {
    const s = M.state;
    const stale = M.neverReflect || s.staleLeft > 0;
    if (s.staleLeft > 0) s.staleLeft--;
    s.results = M.records
      .filter((r) => s.searchCode && r.code.includes(s.searchCode))
      .map((r) => ({ code: r.code, desc: stale && r.prevDesc != null ? r.prevDesc : r.desc }));
    renderResults();
  }

  function serverChange(input, value) {
    const role = input.dataset.role;
    if (role === 'filter') {
      const first = !M.tree.filtered;
      M.tree.filtered = true;
      au(() => {
        applyFilter(value);
        // The session's first filter can be applied again a little later, rebuilding the tree.
        if (first) M.latePasses.forEach((ms) => later(() => au(() => applyFilter(M.tree.filter)), ms));
      }, M.filterLatency);
      return;
    }
    au(() => {
      if (role === 'tagcode') {
        M.state.searchCode = value;
      } else if (role === 'desc') {
        M.state.dirty = value;
        const save = $r('save');
        if (save) save.disabled = false;
      } else if (role === 'search-tag') {
        M.log.push('search-tag-written');
      }
    });
  }

  function serverOk(input) {
    if (input.dataset.role === 'tagcode') au(serverSearch);
  }

  function serverSave() {
    const rec = M.records.find((r) => r.code === M.state.selected);
    if (M.saveFails) {
      const err = document.createElement('div');
      err.className = 'z-errorbox';
      err.textContent = M.saveFails;
      document.getElementById('editor').append(err);
      return;
    }
    rec.prevDesc = rec.desc;
    rec.desc = M.state.dirty;
    M.state.dirty = null;
    M.state.staleLeft = M.staleSearches;
    renderEditor();
    toast(`Item ${rec.code} saved`);
  }

  // --- clicks ------------------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('a.z-a')) {
      e.preventDefault();
      M.log.push('sso-click');
      return;
    }
    const roleRow = t.closest('tr.yw-selector-listitem');
    if (roleRow) {
      au(() => {
        document.querySelectorAll('tr.yw-selector-listitem').forEach((r) => {
          r.classList.remove('z-listitem-selected');
          r.setAttribute('aria-selected', 'false');
        });
        roleRow.classList.add('z-listitem-selected');
        roleRow.setAttribute('aria-selected', 'true');
        M.state.roleSelected = roleRow.textContent.includes('WTCSG Backoffice User Role');
      });
      return;
    }
    if (t.closest('.z-window .z-button')) {
      M.log.push('role-proceed');
      au(() => {
        if (!M.state.roleSelected) return;
        M.state.page = 'shell';
        renderAll();
      });
      return;
    }
    const expander = t.closest('.z-tree-icon');
    if (expander) {
      const folder = expander.closest('.z-treerow').dataset.label;
      M.log.push(`tree-toggle${M.expanderIgnored ? '-ignored' : ''}:${folder}`);
      if (!M.expanderIgnored) setFolder(folder);
      return;
    }
    const treeRow = t.closest('.z-treerow');
    if (treeRow && treeRow.dataset.label === 'Promotion Tag') {
      au(() => {
        M.state.typeOpen = true;
        renderTree();
        renderBrowser();
      });
      return;
    }
    if (t.closest('[data-role="toggle"]')) {
      au(() => {
        M.state.searchOpen = !M.state.searchOpen;
        renderBrowser();
      });
      return;
    }
    if (t.closest('[data-role="search"]')) {
      M.log.push('search');
      au(serverSearch);
      return;
    }
    const row = t.closest('#results tr.z-listitem');
    if (row) {
      const code = row.dataset.code;
      au(() => {
        const open = M.records.find((r) => r.code === M.state.selected);
        if (open && code !== open.code && M.state.dirty != null && M.state.dirty !== open.desc) {
          // Like Backoffice: switching records with an unsaved edit raises a modal dialog.
          M.log.push('unsaved-dialog');
          const dlg = document.createElement('div');
          dlg.className = 'z-messagebox-window z-window-modal';
          dlg.textContent = 'You have unsaved changes. Do you want to save them?';
          document.getElementById('editor').append(dlg);
          return;
        }
        M.state.selected = code;
        M.state.dirty = null;
        renderResults();
        renderEditor();
      });
      return;
    }
    const save = t.closest('[data-role="save"]');
    if (save && !save.disabled) {
      M.log.push('save');
      au(serverSave);
    }
  });
})();
