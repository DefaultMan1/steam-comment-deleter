# Steam Comment Deleter

Delete comments from your Steam profile, with optional filters for text, author, and date. For Brave and Chrome with Tampermonkey.

[![Install Steam Comment Deleter](docs/install.svg)](https://github.com/DefaultMan1/steam-comment-deleter/raw/refs/heads/main/steam-comment-deleter.user.js)

You'll need Tampermonkey first. Follow the three steps below if you haven't used it before.

<img src="docs/comment-deleter-compact.png" alt="Comment Deleter in dark mode" width="322"> <img src="docs/comment-deleter-light.png" alt="Comment Deleter in light mode" width="322">

*The panel in dark and light mode, using sample comments.*

## Install in Brave or Chrome

### 1. Add Tampermonkey

Open [Tampermonkey](https://www.tampermonkey.net/) and choose the Chrome download for either browser. Click **Add to Chrome** (or **Add to Brave**), then **Add extension**.

Open your browser's extensions page by pasting the address below into the address bar:

- **Brave:** `brave://extensions`
- **Chrome:** `chrome://extensions`

Find **Tampermonkey → Details** and turn on **Allow User Scripts**. If that switch is missing, follow [Tampermonkey's permission guide](https://www.tampermonkey.net/faq.php#Q209).

### 2. Add the script

Click **[Install Steam Comment Deleter](https://github.com/DefaultMan1/steam-comment-deleter/raw/refs/heads/main/steam-comment-deleter.user.js)**. On the Tampermonkey screen, click **Install**.

### 3. Open your profile

Open [your Steam profile](https://steamcommunity.com/my/) and sign in. Reload the page if it's already open. Look for the **Comment Deleter** panel with **v1.0.0** in its header.

<details>
<summary>Installation didn't work?</summary>

**The link shows code or downloads a file:**

1. Open **Tampermonkey → Dashboard → Create a new script**.
2. Open [the script file](steam-comment-deleter.user.js) and click **Copy raw file**.
3. Select all text in Tampermonkey's editor, paste the copied code, and press **Ctrl+S**.
4. Reload your Steam profile.

**The panel is missing:** check that Tampermonkey, the script, and **Allow User Scripts** are enabled. Use a profile page; inventory, friends, groups, and comment history aren't supported.

</details>

## Use it

1. Leave **DELETE ALL** unchecked for the current page, or tick it to include later pages. Filters still apply; each run is capped at 500 attempts.
2. Open **Filters & options** if you want to narrow the selection or keep particular comments.
3. Click **Scan comments**, check the highlighted selection, then click **Delete**.

**Stop** or **Escape** prevents further actions. A request already sent to Steam may still finish. Deletion is permanent, and the tool does not save backups.

The theme button switches between light and dark. **×** closes the idle panel; reload Steam to reopen it. Open **Activity** if something goes wrong.

[Filter details, limits, and privacy](docs/usage.md)

## Help and contributions

[Report a problem](https://github.com/DefaultMan1/steam-comment-deleter/issues) with your browser version, what happened, and the Activity message. Leave personal comment text out of the report.

Fixes and suggestions are welcome. See [Contributing](CONTRIBUTING.md) for setup and tests.

[MIT license](LICENSE).
