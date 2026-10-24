# Relevo

🇪🇸 [Leer en español](README.es.md)

**Pick, per VS Code window, which of your accounts Claude Code uses, and spread your weekly quota across the days.**

> Relevo is an **unofficial** community extension. It is not made, endorsed or reviewed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC, mentioned here only to say what Relevo works with.

Relevo is a companion to the official [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension. It is for people with more than one Claude account of their own (say, personal and work) who want each window to use the right one.

> The interface is in English and Spanish: the `relevo.language` setting picks it (by default it follows VS Code's language).

## Usage

**After installing** there is no need to sign in again: Relevo recognizes the account you already use with Claude Code (shown by the name in your email) and any `~/.claude-<name>` profiles you already have signed in. From there, you only add new accounts.

**Switch accounts.** Click **`Claude: A`** in the status bar and pick an account. Only that window's extensions restart (your files, tabs and terminals stay open) and Claude Code starts with the chosen account. Each window remembers its account.

**Add an account.** In the same list, **Add account…** → type a name, e.g. "Work". Relevo creates its profile folder and switches the window to it; Claude Code then shows **its own sign-in form**. Relevo never sees your password or tokens: sign-in happens entirely in Anthropic's official flow. If your browser is already signed in to another claude.ai account, use a private window.

**Remove an account.** **Remove an account from the list…**. Nothing is deleted: its folder and sign-in stay where they were.

**While Claude is answering**, Relevo will not switch (it would cut the answer short); it offers to switch when the answer is done.

**Account usage.** The status bar shows `5h 31% · wk 49% · today 6/14% · 🕘 12 min`: the window's account usage of the 5-hour and weekly limits, and today's budget. These are the figures Claude Code stores on your machine whenever it checks usage. Next to them, `🕘 12 min` always shows how old they are (minutes, then hours, and `+1 day` past a day). **Click the usage to refresh it**: Relevo asks Claude Code to check (it runs Claude Code's `/usage` command, the same as typing it yourself). It never runs on its own.

**Daily budget.** `today 6/14%` = today you have used 6% of the weekly quota and your share is ~14%. It is recomputed every day: (100% − used before today) ÷ days left until the reset. Skip a day and the following days get more; overspend and they get less. Days run from reset time to reset time, so they don't depend on each machine's time zone.

**Usage panel** (link in the usage tooltip, or in the account list):
- *Weekly quota per day*: what each day used and what is left for today and the next days. The percentage is account-wide, so it includes use from any machine or claude.ai.
- *Models and effort*: model and effort level used on this machine, with their relative weight and an approximate share of the quota.
- *Projects*: usage per project on this machine.

## Privacy and terms of use

- **Everything is local.** Relevo makes no network requests, reads no credential files or tokens and sends data nowhere. It only reads configuration files Claude Code writes in your profile folder (such as the usage Claude Code stored) and your local history.
- **Refreshing usage** runs the `/usage` command of your installed, unmodified Claude Code, only when you click. Claude Code does the check, with its own sign-in.
- **Sign-in is always the official one.** Relevo only tells Claude Code which profile folder to use, through the documented [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars) variable. It does not modify Claude Code or its binary.
- **Use only your own accounts.** Each account must be yours, with its own subscription, signed in by you. Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) forbid sharing accounts, and the [Claude Code terms](https://code.claude.com/docs/en/legal-and-compliance) state that plan limits assume ordinary, individual usage. Relevo is for organizing your accounts, not for getting around limits; you are responsible for using it in line with those terms.
- Relevo relies on how Claude Code works on your machine (environment variables and files in its profile folder). A Claude Code update may break it; if so, **Relevo: Diagnostics** shows it.

## Installation

From the Marketplace (search for "Relevo"), or with the `.vsix` from the [releases page](https://github.com/Shirtep/relevo/releases):

```bash
code --install-extension relevo-0.2.0.vsix
```

**Remote-SSH / WSL / containers:** install Relevo **on the same side as Claude Code** (in a remote window: Extensions view → *Install in SSH: …*, or *Install from VSIX…* from that window). Each machine keeps its own sign-ins: a new account is signed in once per machine.

## How it works

- **First account** = Claude Code's default profile (`~/.claude`). Others: `~/.claude-<name>`.
- Relevo sets `CLAUDE_CONFIG_DIR` in **that window's** extension host process, which Claude Code takes its environment from. Every window has its own process, remote ones included. The window's integrated terminals get the same variable.
- Switching accounts = restarting the window's extensions (*Developer: Restart Extension Host*).
- Each account's history (`projects`) is linked to the first one's (a junction on Windows, a symlink on Linux/macOS), so `/resume` works across accounts.
- Relevo has to activate before Claude Code, so it declares the same activation events (`npm run sync-activation` copies them from the installed Claude Code).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `relevo.accounts` | empty: your current account + existing `~/.claude-*` profiles | Accounts and their profile folders. Managed from the status bar. The first one owns the shared history. |
| `relevo.defaultAccount` | `A` | Account for a window where you haven't picked one. |
| `relevo.sharedFolders` | `["projects"]` | Folders of the other accounts that link to the first one's. You can add `skills`, `agents`, `commands`. |
| `relevo.refreshIntervalMinutes` | `1` | How often the usage Claude Code stored is re-read. |
| `relevo.statusBarUsage` | `active` | `active` or `off`. |
| `relevo.language` | `auto` | `auto` (follow VS Code), `en` or `es`. |

## Reporting a problem

Run **Relevo: Report a problem** (also in the account list and in the usage tooltip). It opens a report with the versions, this window's state and the recent log; write what happened at the top, then save or copy it and send it. Emails, user and machine names and folder paths are masked before it is shown, and you can review everything before sharing it.

## Known limits

- Usage is the last figure Claude Code stored; click the usage for a fresh one.
- The models and projects sections only see the history of the machine you are on.
- The per-model share of the quota is an approximation (tokens weighted by each model's public price).

## Undoing the history link

To remove the link without deleting the real history:

- Windows: `cmd /c rmdir "%USERPROFILE%\.claude-b\projects"`. **Don't** use `Remove-Item -Recurse`: on a junction it can delete the target folder's contents.
- Linux / macOS: `rm ~/.claude-b/projects` (no trailing slash).

## Development

```bash
npm install
npm test          # unit tests
npm run package   # builds the .vsix
npm run test:e2e  # isolated VS Code + your installed Claude Code (downloads VS Code into .vscode-test)
```

`test:e2e` opens a window of an isolated VS Code with Relevo and a **copy** of your installed Claude Code, and checks that: (1) with an answer in progress a switch does nothing, (2) without one it restarts the extensions, and (3) Claude Code then uses the other profile. It doesn't touch your VS Code data. From a VS Code terminal run `env -u ELECTRON_RUN_AS_NODE npm run test:e2e`.

Releasing: bump `version` and `CHANGELOG.md`, create the `vX.Y.Z` tag and push it; the *Release* workflow builds the `.vsix` and the GitHub release.

## License

[MIT](LICENSE). Claude Code is governed by Anthropic's own terms; Relevo does not include or redistribute any part of Claude Code.
