# Teams setup

Version 1.2 adds two Teams features:

- **Auto-reply.** When a run finishes, the portal replies under each tag's own Daily Alert with one
  line, for example `959  2 FOR $82.00 → $30 OFF $199 ✅` (since version 1.4; before, one reply under
  the first tag's alert listed them all), and below it a screenshot of the updated tag as proof (since
  version 1.5). The last reply under each alert card ends with who ran it and when, for example
  `Run by watsons via Promo Tag Portal · 22 Oct 2026, 15:08` (since version 1.6; once per card since
  version 1.8). All screenshots
  also stay in the portal's History.
- **"Open in Promo Tag Portal" button** on the alert card. One click opens the portal with the tags
  already filled in.

Steps 1 and 2 are yours. Step 3 is for Jizong, who owns the alert card. This guide assumes the portal
runs on a VM ([DEPLOY-VM.md](DEPLOY-VM.md)); the extension works the same way except where noted.

## 1. Create the reply flow (about 10 minutes)

1. Go to [make.powerautomate.com](https://make.powerautomate.com) → **+ Create** → **Instant cloud flow**.
   Name it `Promo Tag reply`, choose the trigger **When a Teams webhook request is received**, then click **Create**.
2. In the trigger, set **Who can trigger the flow?** to **Anyone**.
3. Add the actions below in this order. **Rename each action right after adding it**: click its title at
   the top of the panel and type the name shown. The expressions only work with these exact names.
   Where a value says *expression*, click in the field, choose **fx** (new designer) or the **Expression**
   tab (classic designer), paste the text into the **fx** box and click **Add** or **OK**. It then shows
   as a purple **fx** pill; plain text there won't work. If Power Automate asks you to sign in to Teams,
   use your work account.

| # | Action (search for) | Rename to | Settings |
|---|---|---|---|
| a | **Compose** | `Channel link` | Inputs: the Daily Alert channel link (in Teams: **⋯** next to the channel → **Copy link**) |
| b | **Compose** | `Messages URL` | Inputs, *expression* **A** below |
| c | **Send a Microsoft Graph HTTP request** (Microsoft Teams) | `Get alerts` | URI, *expression*: `concat(outputs('Messages_URL'), '?$top=50')`<br>Method: **GET** |
| d | **Filter array** | `Find alert` | From, *expression*: `body('Get_alerts')?['value']`<br>Filter Query: click **Edit in advanced mode** and paste `@contains(string(item()), triggerBody()?['match'])` |
| e | **Send a Microsoft Graph HTTP request** | `Post reply` | URI, *expression* **B** below<br>Method: **POST**<br>Body (under Advanced parameters), *expression*: `string(triggerBody()?['message'])` |

Expression **A**:

```
concat('https://graph.microsoft.com/v1.0/teams/', split(split(outputs('Channel_link'), 'groupId=')[1], '&')[0], '/channels/', decodeUriComponent(split(split(outputs('Channel_link'), '/l/channel/')[1], '/')[0]), '/messages')
```

Expression **B**:

```
concat(outputs('Messages_URL'), if(empty(body('Find_alert')), '', concat('/', coalesce(last(sort(body('Find_alert'), 'createdDateTime'))?['id'], ''), '/replies')))
```

4. Click **Save**. Then click the trigger card (**When a Teams webhook request is received**). In its
   panel, copy **HTTP URL** with the copy button at the end of the field. If you are on the flow's
   details page, click **Edit** first. The browser's address bar is not this URL.

The portal calls the flow once for each tag that reached Hybris. Each time, the flow finds the newest
post among the channel's latest 50 that contains that tag's code (for example `956 ||`) and replies
under it, so every tag's result lands in its own alert's thread. If no post matches, it posts a new
message instead. Replies show your name as the sender; the last reply under each card names the portal
user who ran the tags. Tags that were skipped or did not run get no reply.

## 2. Connect the portal (2 minutes)

1. In the portal, open **Settings** (top right), paste the HTTP URL into **Teams reply → Workflow URL**
   and click **Save & Grant access**. (Extension only: click **Allow** when the browser asks.)
2. Click **Send test**. Within about a minute, a test reply appears under the latest Daily Alert, with
   the newest screenshot from History below it (once there is one). If the text arrives but not the
   image, see the table below. Delete the test reply afterwards.

That's it: every finished run now replies on its own. If a reply fails, the portal says why and offers
**Retry Teams reply**. Treat the URL like a password, because anyone who has it can post in the channel
as you. To stop the replies, clear the field and click **Save & Grant access**.

## 3. Add the button to the alert card (Jizong)

Send Jizong the message below. **Replace every `<vm-ip>` in it with the VM's address** (for example
`10.101.32.163`). The links use the portal's address through IIS ([DEPLOY-VM.md](DEPLOY-VM.md), step 10);
without IIS, use `http://<vm-ip>:8080/#promotags=` instead. With the extension instead of the VM, the
link starts with your Backoffice URL, for example `https://<backoffice-host>/backoffice/#promotags=`.

Before you send it:

- The portal must be running when he tries the button.
- Every button points at that address, so it must not change for this VM.
- Anyone who clicks the button without a portal login sees the login page. That's expected.
- A run takes up to 25 tags. If an alert has more, remove the extra rows before **Execute**.

> Hi Jizong, could you add an **"Open in Promo Tag Portal"** button to the WTCSG Daily Alert card? It
> opens our Promo Tag Portal with the alert's tags already filled in. Nothing else on the card changes.
>
> **1. The button.** In the card JSON (the object with `"type": "AdaptiveCard"`), add this next to
> `"body"`. If the card already has an `"actions"` list, just add the `{ … }` entry to it.
>
> ```json
> "actions": [
>   { "type": "Action.OpenUrl", "title": "Open in Promo Tag Portal", "url": "<LINK>" }
> ]
> ```
>
> **2. The link.** `<LINK>` is `http://<vm-ip>/promotag/#promotags=` followed by the card's
> Alert_Message values, one per line, URL-encoded as a whole.
>
> *If the card is built in Power Automate:*
>
> - Before the card step, add a **Select** action and rename it `Alert messages`. **From:** the alert
>   rows the card is built from. **Map:** switch to text mode and enter this as an expression (**fx**):
>   `item()?['Alert_Message']`
> - In the card JSON, set `"url"` to this expression (**fx**):
>   `concat('http://<vm-ip>/promotag/#promotags=', encodeUriComponent(join(body('Alert_messages'), decodeUriComponent('%0A'))))`
> - If you already collect the messages in a variable, you can join that instead of adding the Select.
>
> *If a script builds the card:*
>
> ```python
> link = "http://<vm-ip>/promotag/#promotags=" + urllib.parse.quote("\n".join(messages), safe="")
> ```
>
> ```powershell
> $link = 'http://<vm-ip>/promotag/#promotags=' + [uri]::EscapeDataString($messages -join "`n")
> ```
>
> If the alert is a plain message rather than a card, a link works the same way:
> `<a href="<LINK>">Open in Promo Tag Portal</a>`.
>
> **3. To check it.** For the messages `956 || $10 OFF $99` and `959 || $30 OFF $199`, the link is
> `http://<vm-ip>/promotag/#promotags=956%20%7C%7C%20%2410%20OFF%20%2499%0A959%20%7C%7C%20%2430%20OFF%20%24199`.
> Clicking the button should open the **Promo Tag Portal login page**, which means it works (only
> portal users can log in). If you get a 502 error instead, the portal is down on our side, so just
> let me know.

Once the button is there, clicking it opens the portal with the tags filled in (log in first if
asked). Check the tags, then click **Execute** as usual. Until the button exists, pasting the card
still works.

## If something doesn't work

| Problem | Fix |
|---|---|
| **Save** fails with "contains invalid expression(s)" | The actions must be named exactly `Channel link`, `Messages URL`, `Get alerts`, `Find alert` and `Post reply`, and every expression must show as a purple **fx** pill. |
| **Get alerts** fails with "URI path is not a valid Graph endpoint" | An expression was pasted as plain text. In the failed run, click **Messages URL**: its output must start with `https://graph.microsoft.com/v1.0/teams/`. Re-enter expression **A** and the **Get alerts** URI with **fx**. |
| **Send test** says the workflow refused the request | Set the trigger's **Who can trigger the flow?** to **Anyone**. |
| The test was sent, but nothing appears in Teams | Open the flow's **Run history**. The failed step shows the error. Check the link in `Channel link`. |
| A reply appears as a new message, not in the alert's thread | None of the channel's latest 50 posts contains that tag's code followed by `\|\|` (for example `956 \|\|`). |
| Some replies arrived, then **Teams reply not sent for …** | The portal stops at the first reply that fails. Click **Retry Teams reply**: it sends only the tags listed. |
| The portal says the replies were sent, but none (or no screenshot) appears in Teams | The flow accepted the request but the reply failed inside it. Open the flow's **Run history**: the failed **Post reply** step says why. To go back to replies without screenshots at once, untick **Settings → Teams reply → Include the updated tag's screenshot**. |
| A reply says *(screenshot in the portal's History)* | That tag has no screenshot to send (for example the browser blocked the capture), or it is larger than 2 MB. History has whatever was captured. |
| The button opens the portal but no tags appear | The link must contain `#promotags=` followed by the encoded lines. If you weren't logged in, log in: the tags load right after. |
| Only the first tag appears, with the next code stuck to its description | The Alert_Message values were joined without line breaks. Join them with a line break before encoding (in Power Automate: `decodeUriComponent('%0A')`). |
| The button doesn't open the portal | Your PC must reach the VM: open `http://<vm-ip>/promotag/` by hand, and see [DEPLOY-VM.md](DEPLOY-VM.md), step 10. |
| The button shows **HTTP Error 502.3 - Bad Gateway** | IIS works, but the portal on the VM isn't running. On the VM, double-click `update-portal.cmd` ([DEPLOY-VM.md](DEPLOY-VM.md)): it starts the portal, or says why it can't. |
