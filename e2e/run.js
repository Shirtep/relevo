// End-to-end check of the core assumption, in an isolated VS Code (own user data and extensions):
// a window on account A switches to B by restarting its extension host; does the official Claude
// Code extension then resolve B's profile folder? Re-run after Claude Code updates:
// `npm run package && npm run test:e2e`.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');

const OFFICIAL = 'anthropic.claude-code';
const TIMEOUT_MS = 240_000;

function latestOfficial(extensionsDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf8'));
  const entries = manifest.filter((e) => e.identifier.id === OFFICIAL);
  if (entries.length === 0) throw new Error(`${OFFICIAL} is not installed in ${extensionsDir}`);
  entries.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return entries[entries.length - 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = path.resolve(__dirname, '..');
  const vsix = fs.readdirSync(root).filter((f) => f.endsWith('.vsix')).sort().pop();
  if (!vsix) throw new Error('run `npm run package` first');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-e2e-'));
  const extDir = path.join(work, 'extensions');
  const userDir = path.join(work, 'user-data');
  const workspace = path.join(work, 'workspace');
  const cfg = {
    profileA: path.join(work, 'profile-a'),
    profileB: path.join(work, 'profile-b'),
    marker: path.join(work, 'switched.marker'),
    report: path.join(work, 'report.json'),
    workspace,
  };
  for (const d of [extDir, path.join(userDir, 'User'), workspace]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, 'User', 'settings.json'),
    JSON.stringify({
      'relevo.accounts': [{ id: 'A', configDir: cfg.profileA }, { id: 'B', configDir: cfg.profileB }],
      'relevo.defaultAccount': 'A',
      'relevo.sharedFolders': [],
      'relevo.refreshIntervalMinutes': 600,
      'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false,
    }),
  );

  const version = process.env.VSCODE_VERSION || 'stable';
  const exe = await downloadAndUnzipVSCode({ version, cachePath: path.join(root, '.vscode-test') });
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
  const cliEnv = { ...process.env };
  delete cliEnv.ELECTRON_RUN_AS_NODE;
  cp.execFileSync(cli, [...cliArgs, '--extensions-dir', extDir, '--user-data-dir', userDir, '--install-extension', path.join(root, vsix)], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: cliEnv,
  });

  const manifestPath = path.join(extDir, 'extensions.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const register = (entry, dir) => {
    const posix = dir.split(path.sep).join('/');
    manifest.push({ ...entry, location: { $mid: 1, path: posix.startsWith('/') ? posix : `/${posix}`, scheme: 'file' } });
  };

  // Reuse the locally installed Claude Code instead of downloading it. Copy, never link: the
  // isolated VS Code may update or remove it, and that must not reach the real installation.
  const realExtDir = path.join(os.homedir(), '.vscode', 'extensions');
  const official = latestOfficial(realExtDir);
  const copy = path.join(extDir, official.relativeLocation);
  fs.cpSync(path.join(realExtDir, official.relativeLocation), copy, { recursive: true });
  register(official, copy);

  const driverDir = path.join(extDir, 'local.cas-e2e-driver-0.0.1');
  fs.mkdirSync(driverDir);
  fs.copyFileSync(path.join(__dirname, 'driver.js'), path.join(driverDir, 'driver.js'));
  fs.writeFileSync(path.join(driverDir, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(
    path.join(driverDir, 'package.json'),
    JSON.stringify({ name: 'cas-e2e-driver', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.90.0' }, main: './driver.js', activationEvents: ['onStartupFinished'] }),
  );
  register({ identifier: { id: 'local.cas-e2e-driver' }, version: '0.0.1', relativeLocation: 'local.cas-e2e-driver-0.0.1' }, driverDir);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`Claude Code ${official.version} copied`);

  const child = cp.spawn(exe, [workspace, '--extensions-dir', extDir, '--user-data-dir', userDir, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'], {
    env: cliEnv,
    stdio: 'ignore',
  });
  const read = () => (fs.existsSync(cfg.report) ? JSON.parse(fs.readFileSync(cfg.report, 'utf8')) : {});
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end && !read().after?.done && !fs.existsSync(`${cfg.report}.error`)) await sleep(1000);
  const report = read();
  if (fs.existsSync(`${cfg.report}.error`)) report.error = fs.readFileSync(`${cfg.report}.error`, 'utf8');
  try {
    cp.execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
  } catch {
    child.kill();
  }
  console.log(JSON.stringify(report, null, 2));

  const a = report.after ?? {};
  const ok = report.before?.officialLockInProfileA && report.before.blockedWhileBusy && a.officialLockInProfileB && a.cliUsedProfileB && a.restartedHost && a.envIsProfileB && a.reportOpened && a.reportHasLog && a.reportMasksHome && !report.error;
  await sleep(1500);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(ok ? 'E2E OK: after the switch Claude Code runs on profile B' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
