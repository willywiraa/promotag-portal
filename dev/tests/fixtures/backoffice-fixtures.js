/*
 * Static Backoffice DOM fixtures built from the HTML snippets captured in the real system
 * (IDs, classes, ARIA and placeholders kept verbatim). `data-fx` marks the element each
 * selector key is expected to resolve to.
 */
(function () {
  'use strict';

  function loginPage() {
    return `
      <div class="login-page">
        <form class="login-form">
          <input type="text" name="j_username" class="z-textbox">
          <input type="password" name="j_password" class="z-textbox">
          <button type="button" class="z-button">Login</button>
        </form>
        <a id="lQ3In" class="z-a" data-fx="ssoLink" href="#samlsinglesignon/saml/backoffice/">Login with Single Sign On</a>
      </div>`;
  }

  function roleRow(index, name, id, selected) {
    const sel = selected ? ' z-listitem-selected' : '';
    const label = `Row ${index} of 5, null: &nbsp;${name}, null: &nbsp;${selected ? ',  selected' : ''}`;
    return `<tr id="${id}" class="yw-selector-listitem z-listitem${index % 2 ? '' : ' z-listbox-odd'}${sel}" aria-label="${label}"
      aria-selected="${selected}" role="row" aria-rowindex="${index}">
      <td class="yw-selector-listcell z-listcell" tabindex="-1"><div class="z-listcell-content"><span class="z-listitem-checkable z-listitem-radio"><i class="z-listitem-icon z-icon-radio"></i></span>&nbsp;${name}</div></td>
      <td class="yw-selector-listcell z-listcell" tabindex="-1"><div class="z-listcell-content">&nbsp;</div></td></tr>`;
  }

  function rolePage(opts = {}) {
    const selected = opts.roleSelected !== false;
    return `
      <div class="z-window z-window-modal" role="dialog">
        <div class="z-window-header">Select your role</div>
        <div class="z-window-content">
          <div class="z-listbox"><table><tbody>
            ${roleRow(1, 'WTCHK Backoffice User Role', 'rCbVqc2', false)}
            ${roleRow(2, 'WTCMY Backoffice User Role', 'rCbVrc2', false)}
            ${roleRow(3, 'WTCSG Backoffice Admin Role', 'rCbVsc2', false)}
            <tr id="rCbVtc2" data-fx="roleRow" class="yw-selector-listitem z-listitem z-listbox-odd${selected ? ' z-listitem-selected' : ''}" aria-label="Row 4 of 5, null: &nbsp;WTCSG Backoffice User Role, null: &nbsp;${selected ? ',  selected' : ''}" aria-selected="${selected}" role="row" aria-rowindex="4"><td id="rCbVuc2" class="yw-selector-listcell z-listcell" tabindex="-1"><div id="rCbVuc2-cave" class="z-listcell-content"><span id="rCbVtc2-cm" class="z-listitem-checkable z-listitem-radio"><i class="z-listitem-icon z-icon-radio"></i></span>&nbsp;WTCSG Backoffice User Role</div></td><td id="rCbVvc2" class="yw-selector-listcell z-listcell" tabindex="-1"><div id="rCbVvc2-cave" class="z-listcell-content">&nbsp;</div></td></tr>
            ${roleRow(5, 'WTCTH Backoffice User Role', 'rCbVwc2', false)}
          </tbody></table></div>
          <div class="z-window-footer"><button type="button" class="z-button" data-fx="roleConfirmButton">Proceed</button></div>
        </div>
      </div>`;
  }

  /**
   * opts.rows: [{ code, desc }] result rows; opts.editor: { code, desc } or null; opts.verifyCell: render the
   * second-column label of the first row with the post-save snippet id (#s88Rsza).
   */
  function shell(opts = {}) {
    const rows = opts.rows || [{ code: '895', desc: '10% OFF $80' }];
    const editor = opts.editor === undefined ? rows[0] : opts.editor;
    const toggleState = opts.searchOpen === false ? 'yw-toggle-closed' : 'yw-toggle-open';
    const rowHtml = rows
      .map((r, i) => {
        const first = i === 0;
        const descCell = first && opts.verifyCell
          ? `<div class="z-listcell-content"><span id="s88Rsza" class="yw-listview-cell-label z-label" data-fx="verifyCell">${r.desc}</span></div>`
          : first
            ? `<div id="s88R_da-cave" class="z-listcell-content"><span id="s88R0da" class="yw-listview-cell-label z-label">${r.desc}</span></div>`
            : `<div class="z-listcell-content"><span class="yw-listview-cell-label z-label">${r.desc}</span></div>`;
        return `<tr class="z-listitem${first ? '' : ' z-listbox-odd'}" ${first ? 'data-fx="resultRow"' : ''} role="row">
          <td class="z-listcell"><div class="z-listcell-content"><span class="yw-listview-cell-label z-label">${r.code}</span></div></td>
          <td class="z-listcell">${descCell}</td></tr>`;
      })
      .join('');
    const editorHtml = editor
      ? `<div class="yw-editorarea-container">
          <div class="yw-editorarea-tabbox">
            <div class="yw-editorarea-section-caption z-label">Essential</div>
            <div class="yw-editorarea-attrcell">
              <div class="yw-editorarea-label-container"><span class="z-label">Tag Code</span></div>
              <div class="ye-default-editor"><input class="ye-input-text ye-com_hybris_cockpitng_editor_defaulttext z-textbox" data-fx="editorCode" value="${editor.code}" type="text" readonly aria-readonly="true"></div>
            </div>
            <div class="yw-editorarea-attrcell">
              <div class="yw-editorarea-label-container"><span class="z-label">Tag</span></div>
              <div class="ye-default-editor"><input id="s88R7ea" class="ye-input-text ye-com_hybris_cockpitng_editor_defaulttext z-textbox" data-fx="descInput" value="${editor.desc}" type="text" aria-disabled="false" aria-readonly="false"></div>
            </div>
          </div>
          <div class="yw-editorarea-toolbar"><button type="button" class="y-btn-primary z-button" data-fx="saveButton">Save</button></div>
        </div>`
      : '';
    return `
      <div class="yw-shell" style="display:flex;gap:16px">
        <div class="yw-explorer" style="width:220px">
          <span id="s88Ryb" class="z-bandbox"><input id="s88Ryb-real" data-fx="treeFilter" class="z-bandbox-input" autocomplete="off" aria-autocomplete="none" aria-controls="s88Ryb-pp" value="" type="text" placeholder="Filter tree (Alt+Down for options)" aria-disabled="false" aria-readonly="false"><a class="z-bandbox-button"></a></span>
          <div class="z-tree"><table><tbody>
            <tr class="z-treerow"><td class="z-treecell"><div class="z-treecell-content"><span class="z-label">Promotions</span></div></td></tr>
            <tr class="z-treerow${opts.treeSelected ? ' z-treerow-selected' : ''}" aria-selected="${!!opts.treeSelected}"><td class="z-treecell"><div class="z-treecell-content"><span id="s88Rhr6" class="z-label" data-fx="promotionTagNode">Promotion Tag</span></div></td></tr>
            <tr class="z-treerow"><td class="z-treecell"><div class="z-treecell-content"><span class="z-label">Promotion Tag Group</span></div></td></tr>
          </tbody></table></div>
        </div>
        <div class="yw-workspace" style="flex:1">
          <div class="yw-collectionbrowser">
            <div class="yw-searchbar">
              <input class="z-textbox yw-fulltext-search" type="text" placeholder="Search">
              <button type="button" id="s88Ryh" data-fx="searchModeToggle" class="yw-toggle-advanced-search ${toggleState} z-button" title="Switch search mode"></button>
            </div>
            <div class="yw-advancedsearch" ${opts.searchOpen === false ? 'style="display:none"' : ''}>
              <table><tbody>
                <tr class="yw-advancedsearch-row">
                  <td><span class="z-label">Tag Code</span></td>
                  <td><span class="z-combobox"><input class="z-combobox-input" value="contains"></span></td>
                  <td><div class="ye-default-editor"><input id="s88Rl67" data-fx="tagCodeInput" class="ye-input-text ye-com_hybris_cockpitng_editor_defaulttext z-textbox" value="" type="text" aria-disabled="false" aria-readonly="false"></div></td>
                </tr>
                <tr class="yw-advancedsearch-row">
                  <td><span class="z-label">Tag</span></td>
                  <td><span class="z-combobox"><input class="z-combobox-input" value="contains"></span></td>
                  <td><div class="ye-default-editor"><input class="ye-input-text ye-com_hybris_cockpitng_editor_defaulttext z-textbox" value="" type="text"></div></td>
                </tr>
              </tbody></table>
              <button type="button" class="z-button yw-advancedsearch-search-button" data-fx="searchButton">Search</button>
            </div>
            <div class="z-listbox yw-listview">
              <div class="z-listbox-header"><table><thead><tr class="z-listhead">
                <th class="z-listheader"><div class="z-listheader-content">Tag Code</div></th>
                <th class="z-listheader"><div class="z-listheader-content">Tag</div></th>
              </tr></thead></table></div>
              <div class="z-listbox-body"><table><tbody>${rowHtml}</tbody></table></div>
            </div>
          </div>
          ${editorHtml}
        </div>
      </div>`;
  }

  /** Replaces every id with a random ZK-like id, keeping suffixes such as "-real" / "-cave". */
  function randomizeIds(root) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rnd = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const prefix = 'z' + rnd(3);
    root.querySelectorAll('[id]').forEach((el) => {
      const suffix = (el.id.match(/-[a-z]+$/) || [''])[0];
      el.id = prefix + rnd(3) + suffix;
    });
  }

  function mount(html) {
    const stage = document.getElementById('stage');
    stage.innerHTML = html;
    return stage;
  }

  const fx = (key) => document.querySelector(`[data-fx="${key}"]`);

  window.PTAEFixtures = { loginPage, rolePage, shell, randomizeIds, mount, fx };
})();
