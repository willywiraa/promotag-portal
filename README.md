# Hybris Promo Tag Amendment Portal

Microsoft Edge extension (Manifest V3; also runs in Chrome) that applies DAILY_ALERT promo-tag changes such as
`895 || to change to 10% OFF $70` in SAP Hybris Backoffice. For each alert it:

1. Opens Backoffice and signs in. It clicks *Login with Single Sign On* and selects the *WTCSG Backoffice User Role* if needed.
2. Opens **Promotion Tag**, switches to advanced search, searches the **Tag Code** and opens the record.
3. **Reads and records the current (old) value**, for example `10% OFF $80`, and takes a "before" screenshot.
4. Asks you to confirm `old → new`. This is on by default and can be turned off in Settings.
5. Writes the new description and clicks **Save**.
6. **Clicks Search again** and checks that the result grid shows the new value. If it doesn't, it retries 3 times, waiting 3 s, 5 s and 8 s between attempts.
7. Takes a **final screenshot** and stores the run (old → new, outcome, full log, screenshots) in a
   **local history database** that you can browse, filter and export.

It can also work with the Daily Alert in Teams: an **Open in Promo Tag Portal** button on the alert card
loads the tags for you, and each tag's result is posted as a reply under its alert. See
[TEAMS-SETUP.md](TEAMS-SETUP.md).

Instead of the extension, the same portal can run on a Windows VM and be opened from any PC on the
company network. See [DEPLOY-VM.md](DEPLOY-VM.md).

## Install (Microsoft Edge)

1. In Edge, open `edge://extensions` and turn on **Developer mode** (the switch in the left-hand panel).
2. Click **Load unpacked** and select the `hybris-promotag-extension` folder.
3. Click the puzzle-piece **Extensions** button in the toolbar and click the eye icon next to
   *Hybris Promo Tag Amendment Portal* so it stays visible.

If the Developer mode switch is greyed out ("managed by your organization"), company policy blocks
unpacked extensions and IT has to allow it. The same steps work in Chrome via `chrome://extensions`;
each browser keeps its own login, settings and history.

**After updating the files**, click **Reload** on the extension in `edge://extensions` (or the
**Reload extension** button the popup offers), then press F5 on the Backoffice tab. The bottom of
**Settings** shows which version is running.

## First run

1. **Create a portal login.** On first open you choose a User ID and an access key. Only a salted
   PBKDF2 hash is stored, in this browser profile. To give a team the same logins instead, generate
   entries with `dev/tools/credential-hasher.html` and paste them into `scripts/auth-config.js`.
   Then reload the extension.
2. **Settings** (gear icon, top right; it opens by itself until the Backoffice URL is set). **Back to tags**
   or **Esc** returns to the tags:
   - **Backoffice URL** — for example `https://<your-backoffice-host>/backoffice/`. Click **Save & Grant access**
     and accept the browser's prompt. The extension only runs on that address.
   - **Backoffice role** — defaults to `WTCSG Backoffice User Role`.
   - **Confirm before saving** — on by default.
   - **Always allow screenshots** — optional. See *Screenshots* below.

## Daily use

1. Connect GlobalProtect VPN and open Backoffice in a tab. A tab that isn't logged in is fine.
2. While the Backoffice tab is active, click the extension icon.
3. Fill in the tags, one row per tag (**Tag Code** + **New Tag Description**):
   - Click **Open in Promo Tag Portal** on the Daily Alert card (once it's set up). Backoffice opens and
     the portal opens with the tags filled in. If it doesn't open, its icon shows **NEW**: click it.
   - On the VM portal: click **Load from Daily Alert**, tick the tags and click **Add N tags**. It reads
     the Daily Alert archive in the MasterData database ([DEPLOY-VM.md](DEPLOY-VM.md), step 12) and
     leaves tags History shows as done unticked.
   - **Paste the whole Daily Alert card** (or any lines like `888 || 3 FOR $16.65`) into any row. Every
     `code || description` line becomes its own row, and text such as "to change to" is removed.
     Alerts that aren't promo tags (`MT || Count: 0`) are skipped. Tag codes are numbers.
   - Or type them: **Enter** moves to the next field, **+ Add tag** adds a row, **×** removes one.
   - Up to 25 tags per run. Invalid or duplicate rows are highlighted.
4. Click **Execute N tags**. The tags run one after another in the same Backoffice tab. The steps at the
   top (**Tags → Processing → Review**) show where the run is, and each row shows its live status.
5. For each tag you're asked to confirm **Current in Hybris → New**, next to a screenshot of Backoffice
   before saving:
   - **Confirm & Save** — this tag only.
   - **Skip this tag** — nothing is changed for it; the run continues with the next tag.
   - **Confirm all remaining (N)** — this tag and the rest, without asking again.
   If the popup is closed at that point, the toolbar badge shows **?**; click the icon to answer.
6. When the run finishes, each row shows `old → new` and **Verified**, **Already set**, **Failed**
   (with the reason) or **Skipped**. Click a row for its details: the full message and its screenshots.
   (In the VM portal on a wide screen, the details sit beside the list.) **Retry failed** loads the
   unfinished tags back into the form; **New run** starts over; **Open History** shows all runs.

The **Activity log** under the tags is collapsed; it opens by itself when something fails.

A problem with one tag (not found, save rejected, not reflected) doesn't stop the others. A problem
with the environment (VPN down, session expired, a Backoffice dialog in the way, tab closed) stops the
run and marks the remaining tags *Not run*. If a tag fails after its field was edited but before it
was saved, the edit is undone so Backoffice is left clean for the next tag.

Closing the popup never stops a run. Reopen it to see progress. **Stop** ends the run after undoing
any unsaved edit. **Logout** also stops a run and clears the form and live log; history is kept.

## History

**History** (clock icon) opens a full page listing every run: time, operator, tag code,
**old → new**, outcome and a screenshot thumbnail. From there you can:

- filter by text, outcome or date
- open a run to see its full log and its before/after screenshots (click to enlarge or download)
- **Export CSV**
- delete single runs or runs older than N days

Data lives in this browser profile (IndexedDB). It stays until you delete it or remove the extension.

## Teams reply

When a run finishes, the portal sends each tag's result to your Power Automate flow, which replies
under that tag's own Daily Alert with one line, for example `959  2 FOR $82.00 → $30 OFF $199 ✅`
(also `✅ already set` or `❌ failed`), and below it the screenshot of the updated tag as proof, taken
from that tag's own run (for a failed tag, the screenshot of the failure). Under each Daily Alert
card, the last reply ends with who ran it and when, for example
`Run by watsons via Promo Tag Portal · 22 Oct 2026, 15:08`: the portal user who started the run, and
when that tag finished, in the time zone of the computer running the portal (the VM's, for the VM
portal). Tags are matched to their card by the alert time that came with them, from a pasted card or
**Load from Daily Alert**. Tags without one (typed, or from a link) count as one card.

Tags that were skipped or did not run, and failures of the environment (for example the VPN was
down), get no reply. All screenshots and full details also stay in History. The run view shows
**Teams replies sent ✓**, or which tags weren't sent and why, with **Retry Teams reply** (it sends
only those, with their original time). **Settings → Teams reply** can leave the screenshots out.

Screenshots are JPEG (since version 1.5), small enough to go into the replies.

Setup (flow, workflow URL in Settings, **Send test**) and the button on the alert card are described in
[TEAMS-SETUP.md](TEAMS-SETUP.md).

## Screenshots

Edge (like Chrome) allows an extension to capture a tab only if you opened the extension from that
tab, or if the extension has access to all sites. Hybris access alone is not enough.

- By default, screenshots work when you open the portal from the Backoffice tab.
- They can be lost if the run re-logs in through SSO mid-way. When that happens the run still finishes,
  the log says "screenshot unavailable", and the finished run offers **Capture now**.
- **Always allow screenshots** in Settings removes this limitation. The browser describes it as access
  to all sites, but the scripts still only run on your Backoffice URL.

## Messages you may see

| Message | Meaning |
|---|---|
| `Network Error: Verify GlobalProtect VPN connection.` | Backoffice is unreachable, or requests stopped answering. |
| `Hybris session expired. Re-authenticate via SSO.` | Backoffice logged you out. The portal signs in again once; if that fails, sign in manually and retry. |
| `Tag Code X not found in Hybris.` | The search returned no row with exactly that code. Also check that no other advanced-search fields are filled in. |
| `… result rows show this code` | More than one exact match. The portal aborts without changes. |
| `Change not reflected after 3 retries …` | The save didn't show up in the grid. Check the record manually; the screenshot shows what the grid displayed. |
| `Backoffice rejected the save: …` | Backoffice showed a validation error. Its text is included. |

## If a step can't find something

Backoffice element IDs change every session. Elements are therefore found by labels, ARIA attributes,
placeholders and ZK classes first, and the sample IDs from the PRD are used only as a validated fallback.

If your Backoffice uses different captions:

1. Run the job. The log lists the visible labels and buttons on screen.
2. Adjust `CONFIG` at the top of `hybris-promotag-extension/scripts/selectors.js`. For example:
   - `treeFilterText` (default: `Promotion Tag`), typed into *Filter tree*. Keep it the node's own
     label: Backoffice opens the folders above a match but shows a match itself closed, so a broader
     text such as `promotion` hides Promotion Tag inside the closed *Promotions* folder.
   - `promotionTagParents` (default: `Marketing`, `Promotions`), the tree folders above Promotion Tag,
     opened only if the filter leaves one closed
   - `descriptionLabels` (default: `Tag`, `Tag Description`, `Description`)
   - `tagCodeLabels`
   - `searchButtons`
   - `saveButtons`
   - `roleConfirmButtons`
   - `verify.cooldownsMs`
3. Reload the extension in `edge://extensions`.

## Security notes

- The portal login is a convenience gate inside your browser, not a security boundary. Hybris SSO and
  your Backoffice role remain the real access control. Don't reuse your IT/AD password as the access key.
- The extension never sees or stores Hybris credentials. SSO happens in the Backoffice tab.
- Scripts run only on the Backoffice URL you configured.

## Development

```
hybris-promotag-extension/   the extension (load this folder)
  manifest.json
  popup/                     Portal UI: login, tags → processing → review, settings (also the VM portal's page)
  history/                   History page
  scripts/background.js      service worker: auth, settings, jobs, screenshots, history writes, Teams
  scripts/content.js         automation engine (runs in the Backoffice tab)
  scripts/selectors.js       two-tier selector registry + CONFIG
  scripts/zk-dom.js          DOM/ZK helpers, including setZkInputValue
  scripts/zk-bridge.js       runs in the page context to reach ZK's own widget API
  scripts/shared/            alert parser, batch runner, login crypto, history database, Teams reply + links
dev/tests/                   automated tests (headless Edge; -Browser chrome for Chrome)
dev/tests/ui/                popup/History previews and screenshots
dev/tools/                   credential hasher
vm-portal/                   the portal on a VM (DEPLOY-VM.md): Node runs background.js, Playwright drives Edge
  server.js                  web server: pages, logins (cookies), page API, live updates, screenshots
  start-portal.cmd           starts the portal; update-portal.cmd pulls from GitHub and restarts it
  run-in-background.cmd      runs it without a window from now on, started at sign-in; stop-portal.cmd stops it
  connect-daily-alert.cmd    saves the SQL login for "Load from Daily Alert" (DEPLOY-VM.md, step 12)
  iis/web.config             IIS in front of the portal at /promotag/ (DEPLOY-VM.md, step 10)
  lib/                       chrome.* for Node, the Edge host, History on disk, the Daily Alert archive reader
  page/bootstrap.js          connects the engine in a Backoffice page to the server
  public/                    web shim that lets popup.js and history.js run as web pages
  test/e2e.test.js           end-to-end test against the mock Backoffice (npm test, needs Edge)
```

Run the tests (no VPN needed):

```powershell
powershell -ExecutionPolicy Bypass -File dev\tests\run-tests.ps1
```

The suites cover:

- the alert parser, including skipping alerts that aren't promo tags
- portal login hashing
- selector resilience: the captured HTML snippets with the original IDs, with randomized IDs, with the
  fallback tier alone, and with stale-ID decoys
- ZK input sync
- the history database
- the Teams reply and alert links: message building (including the "Run by" line) and link parsing, plus
  the real service worker run against a stubbed browser (reply, retry, nothing posted on VPN failures,
  link import), and a guard that a failed or unverified save never gets a ✅ reply
- a syntax check
- an end-to-end simulation against a scripted mock Backoffice whose explorer tree filters like the real
  one: the first tag of a fresh session (also when Backoffice filters again, the dashboard refreshes in
  the background, or a filter leaves Promotions closed), single-tag and multi-tag runs, role selection,
  a slow first tree filter, stale grid with retries, never reflected, already up to date, cancel, not
  found, ambiguous, save rejected, session expiry, network down, and blocked screenshots

`dev\tests\ui\capture-ui.ps1` renders every popup state (login, settings, tags, processing,
confirmation, success, failure), the same states as the VM portal at 1366×768 and 1920×1080, and the
History page into `dev\tests\ui\out\`.

The VM portal has its own end-to-end test: in `vm-portal`, run `npm test`. A user opens a Teams link,
creates a login, sets the Backoffice URL, runs two tags against the mock Backoffice, checks History and
logs out. It also checks that private files aren't served, that the first login can't be created
from another PC, and that starting the portal a second time leaves the running one alone.
`test/daily-alert.test.js` checks **Load from Daily Alert** against a stand-in database: which archive
rows become tags, which are left out, and which History marks as done.

Before using it on production data, run it against a QA Backoffice first.
