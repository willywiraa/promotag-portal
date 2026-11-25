# Run the Promo Tag Portal on a Windows VM

The portal runs on the VM instead of in your browser. You and your colleagues open it from any PC on
the company network by its address, e.g. `http://10.101.32.163/promotag/` (through IIS, step 10), and the **Open in Promo Tag Portal** button on the
Daily Alert opens it with the tags already filled in. When you click **Execute**, the VM updates
Backoffice in its own Edge window, then replies in Teams. The pages, steps, confirm screen, History
and Teams reply are the same as the extension's.

The code lives in a private GitHub repository. You change it on your laptop and push; the VM updates
itself with one double-click (see [Updating](#updating)).

## What you need

- A Windows VM where Microsoft Edge can open Backoffice (same network as your laptop) and that can
  reach github.com.
- A VM account that can stay signed in. The portal runs in that account's session.
- A GitHub account.
- For colleagues' PCs: IIS on the VM with Application Request Routing (step 10), or IT opens port 8080.

## 1. Put the project on GitHub (laptop, once)

1. On github.com, click **New repository**. Name it `promotag-portal`, choose **Private**, leave
   README, .gitignore and license off, then click **Create repository**.
2. In VS Code, open a terminal in the project folder and run these two commands. Replace `<you>` with
   your GitHub user name:

   ```
   git remote add origin https://github.com/<you>/promotag-portal.git
   git push -u origin main
   ```

   The first push asks you to sign in to GitHub in the browser.

The repository leaves out `vm-portal\data`, `node_modules` and local tool files (see `.gitignore`).

## 2. Install Node.js and Git on the VM

- **Node.js 24 LTS**: the Windows Installer (.msi) from nodejs.org, or ask IT.
- **Git for Windows**: from git-scm.com, with the default options.

Check both in a new command prompt: `node --version` should print `v24.` followed by more numbers,
and `git --version` should print a version.

## 3. Get the code onto the VM

1. Create a read-only token for the VM on github.com: your profile picture → **Settings** →
   **Developer settings** → **Personal access tokens** → **Fine-grained tokens** →
   **Generate new token**. Name it `promotag VM` and pick an expiration date. Under **Repository
   access**, choose **Only select repositories** → `promotag-portal`. Under **Permissions**, set
   **Contents** to **Read-only**. Generate the token and copy it.
2. On the VM, open a normal command prompt (not **Run as administrator**) and run:

   ```
   git clone https://github.com/<you>/promotag-portal.git C:\PromoTagPortal
   ```

   When Git asks you to sign in, choose **Token** and paste the token. Windows remembers it.
3. Nothing to install: the portal downloads its libraries from npm the first time it starts (step 4).
   If the VM can't reach npm, copy the `vm-portal\node_modules` folder from your laptop into
   `C:\PromoTagPortal\vm-portal\` instead.

**Copied the folders by hand earlier?** Close the portal's console window and rename
`C:\PromoTagPortal` to `C:\PromoTagPortal-old`. Do steps 1–3, then move
`C:\PromoTagPortal-old\vm-portal\data` into `C:\PromoTagPortal\vm-portal\`. That folder holds your
settings, logins, History and Backoffice sign-in.

## 4. Start the portal

Double-click `C:\PromoTagPortal\vm-portal\start-portal.cmd` (`update-portal.cmd` also starts the
portal when it isn't running). Two windows open:

- a console window, which shows `Portal: http://localhost:8080/` and logs every run;
- an Edge window showing **Promo Tag Portal is running**. The portal drives Backoffice in this window.

Keep both open. Closing the Edge window is fine; the portal starts it again. Once everything works
(step 8), step 9 lets the portal run without its console window.

## 5. Create your portal login (on the VM)

On the VM, open `http://localhost:8080/` in Edge or Chrome and create your portal login. Use a portal
access key, not your IT password. For safety, the first login can only be created on the VM itself.

## 6. Settings

In the portal, open **Settings** (top right; it opens by itself the first time):

1. **Backoffice → Backoffice URL**: paste it and click **Save & Grant access**.
2. **Teams reply → Workflow URL**: paste the flow's HTTP URL (see [TEAMS-SETUP.md](TEAMS-SETUP.md)), click
   **Save & Grant access**, then **Send test**.
3. Click **Back to tags**.

## 7. Sign in to Backoffice once (on the VM)

In the portal's Edge window, press **Ctrl+T**, open the Backoffice URL and sign in with Microsoft SSO,
including MFA. Then close that tab with **Ctrl+W**. The VM keeps this session in
`vm-portal\data\edge-profile`.

When the session expires later, a run waits at **Signing in (SSO)**. Sign in again in that Edge
window on the VM within 3 minutes, or sign in and then run again.

## 8. Test it from your laptop

Open the portal (`http://<vm-ip>/promotag/` once IIS is set up in step 10, otherwise
`http://<vm-ip>:8080/`), log in, enter one tag and click **Execute**. Confirm the change, then check
the reply under the Daily Alert. The console window on the VM (in the background, step 9:
`vm-portal\data\portal.log`) shows each step.

The console window shows the address for other PCs after `from other PCs:`.

## 9. Run it in the background

On the VM, double-click `C:\PromoTagPortal\vm-portal\run-in-background.cmd` once. It restarts the
portal without its console window (never during a run) and tells Windows to start it the same way
whenever you sign in to the VM. From then on:

- There's no window to keep open, and closing a window doesn't stop the portal. If the portal stops
  unexpectedly, it starts again within a minute.
- When you sign in, a window opens for a moment while the portal starts.
- The portal's Edge window still opens. The portal drives Backoffice in it, and you sign in there
  when the session expires (step 7).
- What the console window showed goes to `vm-portal\data\portal.log`. Each run's log is also in
  History.
- `stop-portal.cmd` stops the portal. `update-portal.cmd` updates it and starts it again, as before.

The portal still runs in your session, not as a Windows service, because Edge has to be visible for
the SSO sign-in (the same reason IIS can't run it, step 10). To leave the VM, close the Remote Desktop
window with its **X** (this disconnects you). Don't use **Sign out**: that stops the portal until you
sign in again. After the VM restarts (for example for Windows updates), sign in once and the portal
starts by itself. If IT signs out disconnected sessions after some hours, ask them to exempt this
account.

To go back to the console window: run `stop-portal.cmd`, delete the task **Promo Tag Portal** in Task
Scheduler, and double-click `start-portal.cmd`.

## 10. Let colleagues in through IIS

With IIS, everyone opens the portal on the normal web port 80, by the VM's IP or name, for example
`http://10.101.32.163/promotag/`. IIS only passes requests on to the portal. The portal itself keeps
running in your session as before, because it drives a visible Edge window; IIS runs its apps in the
background, where Edge can't show.

You need IIS's **Application Request Routing** add-on. If IIS Manager shows **Server Farms** under the
server, it's installed. Do these steps in IIS Manager on the VM, as administrator:

1. **Turn on forwarding.** Click the server (e.g. `SG01WJH38VP`), double-click **Application Request
   Routing Cache**, then click **Server Proxy Settings…** on the right. Tick **Enable proxy** and click
   **Apply**. This only allows forwarding; your other IIS apps are not affected.
2. **Copy the IIS settings file.** Create the folder `C:\inetpub\promotag` and copy
   `C:\PromoTagPortal\vm-portal\iis\web.config` into it.
3. **Add an application pool.** Click **Application Pools**, then **Add Application Pool…**. Name:
   `PromoTagPortal`; .NET CLR version: **No Managed Code**; pipeline mode: **Integrated**.
4. **Add the application to the right site.** IIS sends a request to the site whose binding matches the
   address. Click each site under **Sites** and look at **Browse** on the right: the site showing
   your VM's IP with `:80` (on this VM, **WatsonTester**: `10.101.32.163:80`) answers
   `http://10.101.32.163/`. If no site shows the IP, use **Default Web Site**. Right-click that site
   and choose **Add Application…**. Alias: `promotag`; application pool: `PromoTagPortal`; physical
   path: `C:\inetpub\promotag`. If you added `promotag` to another site before, right-click it there
   and choose **Remove**; this doesn't delete the folder.
5. **Make IIS the only way in.** Create `C:\PromoTagPortal\vm-portal\data\env.cmd` with Notepad
   containing these two lines, with the address you use:

   ```
   set PTAE_HOST=127.0.0.1
   set PTAE_PUBLIC_URL=http://10.101.32.163/promotag/
   ```

   Then stop the portal (close its console window, or run `stop-portal.cmd` when it runs in the
   background) and double-click `update-portal.cmd`; it starts the portal again with these settings.
6. **Test it.** On the VM, open `http://10.101.32.163/promotag/`; create your portal login there if
   you haven't yet. Then open the same address on your laptop and log in.

Live run updates come through IIS. If IIS holds them back, the page still updates every 3 seconds.
For instant updates, set **Response buffer threshold (KB)** to `0` in the same **Server Proxy
Settings**.

**Without IIS:** leave out `env.cmd` and have IT open port 8080 instead. Colleagues then use
`http://<vm-ip>:8080/`:

```powershell
New-NetFirewallRule -DisplayName 'Promo Tag Portal' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Domain
```

**Logins for colleagues:** create an entry for each person with `dev\tools\credential-hasher.html`.
Paste the entries, as shown, into `C:\PromoTagPortal\vm-portal\data\users.json`, then restart the
portal. That file stays on the VM and is never in GitHub.

## 11. Point the Teams button to the VM

The button's link must open the portal on the VM now, not Backoffice. Ask Jizong to use the portal's
address followed by `#promotags=…`, for example `http://10.101.32.163/promotag/#promotags=…`. The
exact message is in [TEAMS-SETUP.md](TEAMS-SETUP.md), step 3. An IP address can change when the VM is
moved or rebuilt; the VM's name keeps working if it points to the same site.

## 12. Load tags straight from the Daily Alert (optional)

With this, **Load from Daily Alert** appears under the tag rows. It reads `DAILY_ALERT_ARCHIVE` on the
MasterData database (10.100.32.70), the table where every Daily Alert is kept after it is sent to
Teams. It lists that day's promo tags (or the last 3 or 7 days), with the ones History shows as done
unticked. Tick the ones you want, click **Add N tags**, then **Execute** as usual.

The portal reads the table only when someone clicks the button. It never writes to it, never checks it
on a timer, and saves nothing in Hybris until someone clicks **Execute** and confirms. Alerts that
aren't promo tags (`MT || Count: 0`, `TLOG || Count: 98`, `Missing PB File …`) are left out. If a tag
has several alerts, the newest one is used.

You need a SQL login that can read `DAILY_ALERT_ARCHIVE` (SQL Server authentication; the VM's Windows
login is not accepted there). A login that can only read is best.

1. Sign in to the VM as the user who runs the portal.
2. Double-click `C:\PromoTagPortal\vm-portal\connect-daily-alert.cmd`. Press **Enter** to keep the
   server, database and table it suggests, then type the SQL login and its password.
3. It tries the login right away and shows the latest alerts it can read. Only then does it save
   `data\daily-alert.json`. The password is encrypted for this Windows user on this VM, so it can't be
   used if the file is copied elsewhere. That file is never in GitHub.
4. Reload the portal page. The button is there for everyone who logs in to the portal. No restart is
   needed.

To change the login, run `connect-daily-alert.cmd` again. To remove it (and the button), run
`connect-daily-alert.cmd -Remove` in a command prompt.

## Updating

After you change anything on your laptop:

1. **Laptop:** commit and push. In VS Code, open **Source Control**, type a message, click **Commit**,
   then **Sync Changes**.
2. **VM:** double-click `C:\PromoTagPortal\vm-portal\update-portal.cmd`.

The update script checks GitHub. If something is new, it stops the portal, pulls the changes,
reinstalls the libraries if they changed, and starts the portal again (in the background, if you did
step 9). If nothing is new, it leaves a running portal alone, and starts it if it isn't running. It
never stops the portal during a run; it tells you to try again later. It never touches
`vm-portal\data`.

**To restart the portal** (for example after changing `data\env.cmd` or `data\users.json`): run
`stop-portal.cmd` (or close the console window), then double-click `update-portal.cmd`.

Don't edit files in `C:\PromoTagPortal` on the VM. The update refuses to overwrite them, so make
changes on your laptop and push them.

## Good to know

- **Whose account changes Backoffice:** every run uses the Backoffice session signed in on the VM
  (yours). The portal's History records which portal user ran each change.
- **Keep `vm-portal\data` private.** It holds the settings (including the Teams workflow URL), the
  logins, the Daily Alert database login (step 12), History with screenshots, and the Edge profile
  with your Backoffice session.
- **One run at a time.** Everyone who is logged in sees the same run and its confirm screen.
- **Plain HTTP:** the portal uses HTTP inside the company network. With IIS, adding an HTTPS binding
  with a company certificate to the site the application sits in makes `https://<vm-name>/promotag/` work too.
- **Settings for this VM** (port, IIS, proxy) go in `vm-portal\data\env.cmd`, never in
  `start-portal.cmd`, so updates keep them.

## If something doesn't work

| Problem | Fix |
|---|---|
| The console (in the background: `data\portal.log`) says **The libraries could not be installed**, or **Cannot find module 'playwright-core'** | The VM couldn't download the libraries from npm; the lines above it say why. If the VM reaches the internet through a proxy, add the two proxy lines to `data\env.cmd` (see `start-portal.cmd`). Otherwise copy `vm-portal\node_modules` from your laptop into `C:\PromoTagPortal\vm-portal\`. Then start the portal again. |
| The console (in the background: `data\portal.log`) says **Microsoft Edge did not start** | Check that Edge opens normally on the VM, then restart the portal (see [Updating](#updating)). |
| `start-portal.cmd` says **Port 8080 is in use: the portal is probably running already** | It is, usually in the background (step 9): nothing to do. `update-portal.cmd` restarts it; `stop-portal.cmd` stops it. If `http://localhost:8080/` doesn't show the portal, see the last row. |
| The portal is down after you signed out of the VM, or after the VM restarted | Sign in to the VM. In the background (step 9), the portal starts by itself; otherwise double-click `update-portal.cmd`. |
| The update says **The portal did not start** | In the background, it shows the end of `data\portal.log`, which says why; otherwise the portal's console window does. Fix that, then run the update again. |
| A run stays at **signing in (SSO)** | Sign in to Backoffice in the portal's Edge window on the VM (step 7). |
| Microsoft sign-in says this browser or device isn't allowed, or Edge asks you to sign in to the browser | In the portal's Edge window, sign in to Edge itself with your work account (profile icon, top right), then sign in to Backoffice again. |
| **Network Error: Verify GlobalProtect VPN connection** | The VM can't reach Backoffice. Check that the Backoffice URL opens in Edge on the VM. |
| Colleagues can't open the portal | Check that `http://<vm-ip>/promotag/` works on the VM itself; if it does, port 80 is blocked between their PCs and the VM (ask IT). Without IIS: open port 8080 (step 10). |
| `http://<vm-ip>/promotag/` shows **502** or **Bad Gateway** | The portal isn't running: double-click `update-portal.cmd` on the VM. |
| `http://<vm-ip>/promotag/` shows **404** | Check step 10: the `promotag` application must sit in the site that answers that address (its **Browse** shows the IP), **Enable proxy** must be ticked, and `web.config` must be in `C:\inetpub\promotag`. |
| The browser asks for a Windows user name and password at `/promotag/` | The site the application sits in requires Windows sign-in. Click `promotag` in IIS Manager → **Authentication** → enable **Anonymous Authentication**; the portal has its own login. |
| **Teams reply not sent: Could not reach the Teams workflow** | The VM needs internet access to Power Automate. If it goes through a proxy, add `set NODE_USE_ENV_PROXY=1` and `set HTTPS_PROXY=<proxy address from IT>` to `data\env.cmd`, then restart the portal. |
| Git says **detected dubious ownership** | The folder was created as administrator. The update script fixes this by itself. For other Git commands, run once in a normal command prompt: `git config --global --add safe.directory C:/PromoTagPortal` |
| The update says **Could not get the updates from GitHub** | Git's own message is shown above it. Check the VM's internet access. If the token expired, create a new one (step 3). Then open **Credential Manager** → **Windows Credentials**, remove `git:https://github.com`, and run the update again; it asks for the new token. |
| The update says files were changed on this VM | Run the command it shows to undo them, then update again. Make changes on your laptop instead. |
| The update says **A run is in progress** | Wait until the run has finished (or skip its confirmation), then update again. |
| **Load from Daily Alert** isn't there | Run `connect-daily-alert.cmd` on the VM (step 12), then reload the page. |
| **Could not read the Daily Alert: Login failed for user …** | The SQL login or password is wrong, or the login has no access to MasterData. Run `connect-daily-alert.cmd` again. |
| **Could not read the Daily Alert: A network-related or instance-specific error …** | The VM can't reach 10.100.32.70 on port 1433. On the VM, `Test-NetConnection 10.100.32.70 -Port 1433` in PowerShell must say `TcpTestSucceeded : True`; if not, ask IT to open it. |
| **Could not read the Daily Alert: Key not valid for use in specified state** | The portal runs as a different Windows user from the one who ran `connect-daily-alert.cmd`. Run it again, signed in as the user who runs the portal. |
| **Could not read the Daily Alert: Invalid object name** or **Invalid column name** | The table isn't `dbo.DAILY_ALERT_ARCHIVE` with the columns `Alert_Datetime` and `Alert_Message`. Run `connect-daily-alert.cmd` and enter the right table name. |
| Another program already uses port 8080 | Add `set PTAE_PORT=<another port>` to `data\env.cmd`, change 8080 in `C:\inetpub\promotag\web.config` to match, and restart the portal. |
