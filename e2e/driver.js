// Extension installed next to the switcher and Claude Code in the isolated VS Code (a normal
// window, not the extension-development mode: that mode never completes a host restart).
// The window starts on account A; this driver switches it to B, which restarts the extension
// host. It activates again in the new host, so it has two phases told apart by a marker file:
// "before" (on A, trigger the switch) and "after" (on B, verify). Settings come from config.json.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(500);
  }
  return check();
}

/** Claude Code's IDE lock for this window, written under the profile it resolved. */
function lockFor(profile) {
  const dir = path.join(profile, 'ide');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((name) => {
    try {
      const folders = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).workspaceFolders;
      return folders.some((f) => f.toLowerCase() === cfg.workspace.toLowerCase());
    } catch {
      return false;
    }
  });
}

async function run() {
  const official = vscode.extensions.getExtension('anthropic.claude-code');
  const switcher = vscode.extensions.getExtension('a-shirtep.relevo');
  const report = fs.existsSync(cfg.report) ? JSON.parse(fs.readFileSync(cfg.report, 'utf8')) : {};
  const save = () => fs.writeFileSync(cfg.report, JSON.stringify(report, null, 2));
  const after = fs.existsSync(cfg.marker);
  const r = (report[after ? 'after' : 'before'] = { pid: process.pid });

  r.switcherActive = await waitFor(() => switcher?.isActive === true, 30_000);
  r.officialActive = await waitFor(() => official?.isActive === true, 60_000);
  r.envInExtensionHost = process.env.CLAUDE_CONFIG_DIR ?? null;

  if (!after) {
    r.officialLockInProfileA = await waitFor(() => lockFor(cfg.profileA), 30_000);
    // While Claude is answering (its CLI marks the session "busy"), asking for B must not restart anything.
    const sessions = path.join(cfg.profileA, 'sessions');
    const sessionFile = path.join(sessions, `${process.pid}.json`);
    const session = (status) => JSON.stringify({ pid: process.pid, status, entrypoint: 'claude-vscode', kind: 'interactive', cwd: cfg.workspace });
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(sessionFile, session('busy'));
    void vscode.commands.executeCommand('relevo.switch', 'B'); // waits on a notification nobody answers
    await sleep(8000);
    r.blockedWhileBusy = process.env.CLAUDE_CONFIG_DIR === cfg.profileA && !fs.existsSync(cfg.marker);
    save();
    // Once the answer is over the same request goes through.
    fs.writeFileSync(sessionFile, session('idle'));
    fs.writeFileSync(cfg.marker, 'switching');
    await vscode.commands.executeCommand('relevo.switch', 'B').then(undefined, () => {
      // rejected as "Canceled" when this host is replaced
    });
    return;
  }

  r.officialLockInProfileB = await waitFor(() => lockFor(cfg.profileB), 30_000);
  // A new Claude tab starts the CLI; with an empty profile it creates <profile>/.claude.json.
  await vscode.commands.executeCommand('claude-vscode.editor.open');
  r.cliUsedProfileB = await waitFor(() => fs.existsSync(path.join(cfg.profileB, '.claude.json')), 60_000);
  r.restartedHost = report.before?.pid !== undefined && report.before.pid !== process.pid;
  r.envIsProfileB = process.env.CLAUDE_CONFIG_DIR === cfg.profileB;
  r.done = true;
  save();
}

exports.activate = () => {
  run().catch((e) => {
    fs.writeFileSync(cfg.report + '.error', String(e && e.stack ? e.stack : e));
  });
};
