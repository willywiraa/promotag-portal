# Run the Promo Tag Portal on a Windows VM

The portal runs on the VM instead of in your browser. You and your colleagues open it from any PC on
the company network at `http://<vm-name>:8080/`, and the **Open in Promo Tag Portal** button on the
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
- Only if colleagues use it from their PCs: IT opens port 8080 on the VM (step 10).

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
2. On the VM, open a command prompt and run:

   ```
   git clone https://github.com/<you>/promotag-portal.git C:\PromoTagPortal
   ```

   When Git asks you to sign in, choose **Token** and paste the token. Windows remembers it.
3. Install the libraries:

   ```
   cd C:\PromoTagPortal\vm-portal
   npm ci
   ```

   If the VM can't download from npm, copy `vm-portal\node_modules` from your laptop instead.

**Copied the folders by hand earlier?** Close the portal's console window and rename
`C:\PromoTagPortal` to `C:\PromoTagPortal-old`. Do steps 1–3, then move
`C:\PromoTagPortal-old\vm-portal\data` into `C:\PromoTagPortal\vm-portal\`. That folder holds your
settings, logins, History and Backoffice sign-in.

## 4. Start the portal

Double-click `C:\PromoTagPortal\vm-portal\start-portal.cmd`. Two windows open:

- a console window, which shows `Portal: http://localhost:8080/` and logs every run;
- an Edge window showing **Promo Tag Portal is running**. The portal drives Backoffice in this window.

Keep both open. Closing the Edge window is fine; the portal starts it again.

## 5. Create your portal login (on the VM)

On the VM, open `http://localhost:8080/` in Edge or Chrome and create your portal login. Use a portal
access key, not your IT password. For safety, the first login can only be created on the VM itself.

## 6. Settings

In the portal, open **⚙ Settings**:

1. **Backoffice URL**: paste it and click **Save & Grant access**.
2. **Teams reply: workflow URL**: paste the flow's HTTP URL (see [TEAMS-SETUP.md](TEAMS-SETUP.md)), click
   **Save & Grant access**, then **Send test**.

## 7. Sign in to Backoffice once (on the VM)

In the portal's Edge window, press **Ctrl+T**, open the Backoffice URL and sign in with Microsoft SSO,
including MFA. Then close that tab with **Ctrl+W**. The VM keeps this session in
`vm-portal\data\edge-profile`.

When the session expires later, a run waits at **signing in (SSO)**. Sign in again in that Edge
window on the VM within 3 minutes, or sign in and then run again.

## 8. Test it from your laptop

Open `http://<vm-name>:8080/`, log in, enter one tag and click **Execute**. Confirm the change, then
check the reply under the Daily Alert. The console window on the VM shows each step.

To find `<vm-name>`, look at the console window: it shows `from other PCs: http://<vm-name>:8080/`.

## 9. Start it automatically

On the VM, open PowerShell as your normal user and run:

```powershell
Register-ScheduledTask -TaskName 'Promo Tag Portal' `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") `
  -Action (New-ScheduledTaskAction -Execute 'C:\PromoTagPortal\vm-portal\start-portal.cmd') `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero))
```

The portal now starts whenever you sign in to the VM. To leave the VM, close the Remote Desktop window
with its **X** (this disconnects you). Don't use **Sign out**: that stops the portal. If IT signs out
disconnected sessions after some hours, ask them to exempt this account.

## 10. Let colleagues in (optional)

IT, or you as an administrator, opens the port on the VM:

```powershell
New-NetFirewallRule -DisplayName 'Promo Tag Portal' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Domain
```

To give each person their own login, create an entry for them with `dev\tools\credential-hasher.html`.
Paste the entries, as shown, into `C:\PromoTagPortal\vm-portal\data\users.json`, then restart the
portal. That file stays on the VM and is never in GitHub.

## 11. Point the Teams button to the VM

The button's link must open the VM now, not Backoffice. Ask Jizong to use
`http://<vm-name>:8080/#promotags=…` in the card. The exact message is in
[TEAMS-SETUP.md](TEAMS-SETUP.md), step 3.

## Updating

After you change anything on your laptop:

1. **Laptop:** commit and push. In VS Code, open **Source Control**, type a message, click **Commit**,
   then **Sync Changes**. You can also ask Claude to commit and push.
2. **VM:** double-click `C:\PromoTagPortal\vm-portal\update-portal.cmd`.

The update script checks GitHub. If nothing is new, it leaves the portal alone. Otherwise it stops the
portal, pulls the changes, reinstalls the libraries if they changed, and starts the portal again. It
never stops the portal during a run; it tells you to try again later. It never touches
`vm-portal\data`.

Don't edit files in `C:\PromoTagPortal` on the VM. The update refuses to overwrite them, so make
changes on your laptop and push them.

## Good to know

- **Whose account changes Backoffice:** every run uses the Backoffice session signed in on the VM
  (yours). The portal's History records which portal user ran each change.
- **Keep `vm-portal\data` private.** It holds the settings (including the Teams workflow URL), the
  logins, History with screenshots, and the Edge profile with your Backoffice session.
- **One run at a time.** Everyone who is logged in sees the same run and its confirm screen.
- **Plain HTTP:** the portal uses HTTP inside the company network.

## If something doesn't work

| Problem | Fix |
|---|---|
| The console says **Microsoft Edge did not start** | Check that Edge opens normally on the VM, then restart the portal. |
| A run stays at **signing in (SSO)** | Sign in to Backoffice in the portal's Edge window on the VM (step 7). |
| Microsoft sign-in says this browser or device isn't allowed, or Edge asks you to sign in to the browser | In the portal's Edge window, sign in to Edge itself with your work account (profile icon, top right), then sign in to Backoffice again. |
| **Network Error: Verify GlobalProtect VPN connection** | The VM can't reach Backoffice. Check that the Backoffice URL opens in Edge on the VM. |
| Colleagues can't open the portal | Open the port (step 10), and use the VM name shown in the console window. |
| **Teams reply not sent: Could not reach the Teams workflow** | The VM needs internet access to Power Automate. If it goes through a proxy, put IT's proxy address into the two `set` lines in `start-portal.cmd`. |
| The update says **Could not reach GitHub** | Check the VM's internet access. If the token expired, create a new one (step 3). Then open **Credential Manager** → **Windows Credentials**, remove `git:https://github.com`, and run the update again; it asks for the new token. |
| The update says files were changed on this VM | Run the command it shows to undo them, then update again. Make changes on your laptop instead. |
| The update says **A run is in progress** | Wait until the run has finished (or skip its confirmation), then update again. |
| Port 8080 is already in use | In `start-portal.cmd`, set `PTAE_PORT` to another port, and use it in the links and the firewall rule. |
