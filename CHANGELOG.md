# Changelog

## 0.2.0

- English interface, with Spanish as a translation. The `relevo.language` setting picks it (by default it follows VS Code).
- **Report a problem**: builds a report with versions, the window's state and the recent log, with emails, user and machine names and folder paths masked. Available from the account list, the usage tooltip and every error message.
- Today's budget no longer moves during the day: the start of each quota day is worked out once and kept, so restarts, reloads or reinstalls don't change it.
- More detailed log of switches, usage refreshes and errors.
- Release workflow can be run by hand from the Actions tab.

## 0.1.0

First public release.

- Account per window: each VS Code window picks the profile the Claude Code extension works with. Switching restarts only that window's extensions.
- Recognizes the account you already use with Claude Code and existing `~/.claude-*` profiles: no need to sign in again.
- Add and remove accounts from the status bar; sign-in is Claude Code's official form.
- Never switches while Claude is answering: offers to switch when the answer is done.
- Shared history across accounts (`/resume` works between them).
- 5-hour and weekly usage of the window's account, plus a daily budget that spreads what is left of the week over the remaining days.
- Click the usage to refresh it: runs Claude Code's `/usage`, only when you ask.
- Usage panel: weekly quota per day, models and effort, and projects.
- Fully local: reads no credentials or tokens and makes no network requests.
