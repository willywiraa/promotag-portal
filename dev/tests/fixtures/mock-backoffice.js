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
  function widgetFor(el) {
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
    M.latency = opts.latency || 120;
    M.filterLatency = opts.filterLatency || null; // a slow first tree filter
    M.folderCollapsed = !!opts.folderCollapsed; // the filter leaves "Promotions" collapsed
    M.networkDown = !!opts.networkDown;
    M.staleSearches = opts.staleSearches || 0;
    M.neverReflect = !!opts.neverReflect;
    M.saveFails = opts.saveFails || null;
    M.records = (opts.records || [{ code: '895', desc: '10% OFF $80' }]).map((r) => Object.assign({ prevDesc: null }, r));
    M.log = [];
    M.state = {
      page: opts.page || 'shell',
      roleSelected: false,
      treeFiltered: !!opts.treeFiltered,
      typeOpen: !!opts.typeOpen,
      searchOpen: !!opts.searchOpen,
      searchCode: '',
      results: [],
      selected: null,
      dirty: null,
      staleLeft: 0,
    };
    app().innerHTML = '';
    renderAll();
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

  function renderTree() {
    const s = M.state;
    const open = !M.folderCollapsed;
    // [label, folder state]: like ZK, a folder row has an expander (caret right = closed, down = open).
    const nodes = !s.treeFiltered
      ? [['Catalog'], ['System'], ['User']]
      : [['Marketing', 'open'], ['Promotions', open ? 'open' : 'closed']].concat(open ? [['Promotion Tag'], ['Promotion Tag Group']] : []);
    document.getElementById('tree-body').innerHTML = nodes
      .map(([n, folder]) => {
        const sel = n === 'Promotion Tag' && s.typeOpen;
        const icon = folder ? `<span id="${zid()}-open" class="z-tree-icon"><i class="z-icon-caret-${folder === 'open' ? 'down' : 'right'}"></i></span>` : '';
        return `<tr id="${zid()}" class="z-treerow${sel ? ' z-treerow-selected' : ''}" aria-selected="${sel}">
          <td class="z-treecell"><div class="z-treecell-content">${icon}<span id="${zid()}" class="z-label">${n}</span></div></td></tr>`;
      })
      .join('');
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
      au(() => {
        M.state.treeFiltered = /promo/i.test(value);
        renderTree();
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
      const folder = expander.closest('.z-treerow').textContent.trim();
      M.log.push(`tree-toggle:${folder}`);
      au(() => {
        if (folder === 'Promotions') M.folderCollapsed = !M.folderCollapsed;
        renderTree();
      });
      return;
    }
    const treeRow = t.closest('.z-treerow');
    if (treeRow && treeRow.textContent.trim() === 'Promotion Tag') {
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
