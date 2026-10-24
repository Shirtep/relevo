// Copies Claude Code's activation events (explicit and the implicit ones VS Code derives from its
// views and commands) into this extension's package.json. Whatever activates Claude Code must also
// activate the switcher in the same batch, where the switcher's folder name sorts first; otherwise
// Claude Code can start before CLAUDE_CONFIG_DIR is set. Re-run after Claude Code updates.
const fs = require('fs');
const os = require('os');
const path = require('path');

const extensionsDir = process.argv[2] || path.join(os.homedir(), '.vscode', 'extensions');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf8'));
const official = manifest
  .filter((e) => e.identifier.id === 'anthropic.claude-code')
  .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
  .pop();
if (!official) {
  throw new Error(`anthropic.claude-code is not installed in ${extensionsDir}`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(extensionsDir, official.relativeLocation, 'package.json'), 'utf8'));

const events = new Set(['*']);
for (const e of pkg.activationEvents ?? []) {
  if (e !== 'onStartupFinished') {
    events.add(e);
  }
}
for (const views of Object.values(pkg.contributes?.views ?? {})) {
  for (const v of views) {
    events.add(`onView:${v.id}`);
  }
}
for (const c of pkg.contributes?.commands ?? []) {
  events.add(`onCommand:${c.command}`);
}
for (const w of pkg.contributes?.walkthroughs ?? []) {
  events.add(`onWalkthrough:${w.id}`);
}
events.add('onUri');

const ownPath = path.join(__dirname, '..', 'package.json');
const own = JSON.parse(fs.readFileSync(ownPath, 'utf8'));
own.activationEvents = [...events];
fs.writeFileSync(ownPath, JSON.stringify(own, null, 2) + '\n');
console.log(`${events.size} activation events from Claude Code ${official.version}`);
