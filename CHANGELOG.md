# Changelog

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
