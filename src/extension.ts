import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Account, AccountConfig, baseConfigDirEnv, defaultAccountConfigs, newAccountConfig, resolveAccounts, samePath } from './accounts';
import { language, resolveLanguage, setLanguage, t, translations } from './i18n';
import { PanelData, UsagePanel } from './panel';
import { alignCleanupPeriod, canCopySettings, copySettings, ensureSharedFolders, linkStatus } from './profiles';
import { Budget, Sample, UsageHistory, dailyBudget, quotaDayStart, quotaDays, usedSince } from './history';
import { makeRedactor } from './report';
import { workingSessions } from './sessions';
import { scanTranscripts } from './transcripts';
import { AccountUsage, UsageWindow, effectivePct, readAccountInfo, readUsage } from './usage';

const OFFICIAL_ID = 'anthropic.claude-code';
const SECTION = 'relevo';
const STATE_KEY = 'relevo.account';
const SWITCHED_KEY = 'relevo.justSwitched';
const RESTART_HOSTS = 'workbench.action.restartExtensionHost';
/** One extra day so every local day of the 7 shown is covered whatever the host's timezone. */
const SCAN_DAYS = 8;
/** When this extension host process started; files older than that belong to a previous host. */
const HOST_STARTED = Date.now() - process.uptime() * 1000;
/** How many of the latest log lines go into a problem report. */
const REPORT_LOG_LINES = 300;

interface PendingSwitch {
  target: Account;
  timer: NodeJS.Timeout;
  idleTicks: number;
}

let ctx: vscode.ExtensionContext;
let log: vscode.LogOutputChannel;
let history: UsageHistory;
let accounts: Account[] = [];
let active: Account;
/** Usage of the account this window is using; other accounts are not queried. */
let activeUsage: AccountUsage | undefined;
/** Set while waiting for Claude to finish its answer before switching. */
let pending: PendingSwitch | undefined;
/** Set from the moment the switch starts until the extension host restarts. */
let switchingTo: Account | undefined;
/** The accounts setting changed under the running host, so process.env no longer matches. */
let stale = false;
let accountItem: vscode.StatusBarItem;
let usageItem: vscode.StatusBarItem;
/** Set while Claude Code's /usage runs on the user's request. */
let updating = false;
let timer: NodeJS.Timeout | undefined;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

function loadAccounts(): Account[] {
  return resolveAccounts(config().get<AccountConfig[]>('accounts'));
}

function selectedAccount(): Account {
  const id = ctx.workspaceState.get<string>(STATE_KEY) ?? config().get<string>('defaultAccount');
  return accounts.find((a) => a.id.toLowerCase() === id?.toLowerCase()) ?? accounts[0];
}

function primaryAccount(): Account {
  return accounts[0];
}

function intervalMs(): number {
  return Math.max(1, config().get<number>('refreshIntervalMinutes', 1)) * 60_000;
}

function folders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function applyLanguage(): void {
  setLanguage(resolveLanguage(config().get<string>('language'), vscode.env.language));
}

/**
 * Points this window's extension host at the account. Claude Code runs in the same process and
 * builds every new session's environment from process.env, so this is what selects the account;
 * the terminal collection does the same for `claude` typed in this window's terminals.
 */
function applyAccount(account: Account): void {
  if (account.envValue === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = account.envValue;
  }
  const terminals = ctx.environmentVariableCollection;
  terminals.description = t('Claude: account {0}', account.label);
  if (account.envValue === undefined || account.envValue === baseConfigDirEnv()) {
    terminals.clear();
  } else {
    terminals.replace('CLAUDE_CONFIG_DIR', account.envValue);
  }
}

/** Runs a command handler, logging any failure and offering a problem report instead of failing silently. */
function guard<A extends unknown[]>(name: string, fn: (...args: A) => unknown): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      log.error(`${name} failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
      const report = t('Report a problem');
      void vscode.window.showErrorMessage(t('Relevo: something went wrong ({0}).', e instanceof Error ? e.message : String(e)), report).then((c) => {
        if (c === report) {
          void reportProblem();
        }
      });
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  // Keep this block synchronous and first: Claude Code must see the account in process.env
  // before it activates, which is why the publisher id sorts ahead of "anthropic".
  ctx = context;
  applyLanguage();
  accounts = loadAccounts();
  active = selectedAccount();
  applyAccount(active);

  log = vscode.window.createOutputChannel('Relevo', { log: true });
  context.subscriptions.push(log);
  const official = vscode.extensions.getExtension(OFFICIAL_ID);
  log.info(
    `activated: Relevo ${context.extension.packageJSON.version}, VS Code ${vscode.version}, ${process.platform} ${os.release()}, ` +
      `remote=${vscode.env.remoteName ?? 'none'}, host=${kindLabel(context.extension.extensionKind)}, ` +
      `Claude Code ${official?.packageJSON.version ?? 'missing'} (${official ? kindLabel(official.extensionKind) : '-'}, active=${official?.isActive ?? false})`,
  );
  log.info(`accounts: ${accounts.map((a) => `${a.id}${a === active ? '*' : ''}`).join(', ')}; window account ${active.id}; CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? 'unset'}`);
  history = new UsageHistory(context.globalStorageUri.fsPath);

  accountItem = vscode.window.createStatusBarItem('relevo.account', vscode.StatusBarAlignment.Right, 101);
  accountItem.name = t('Claude: account');
  accountItem.command = 'relevo.switch';
  usageItem = vscode.window.createStatusBarItem('relevo.usage', vscode.StatusBarAlignment.Right, 100);
  usageItem.name = t('Claude: usage');
  // Clicking the usage asks Claude Code for fresh figures; the panel opens from the tooltip.
  usageItem.command = 'relevo.updateUsage';
  context.subscriptions.push(accountItem, usageItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('relevo.switch', guard('switch', (id?: unknown) => (typeof id === 'string' ? switchToId(id) : chooseAccount()))),
    vscode.commands.registerCommand('relevo.addAccount', guard('addAccount', addAccount)),
    vscode.commands.registerCommand('relevo.removeAccount', guard('removeAccount', removeAccount)),
    vscode.commands.registerCommand('relevo.showUsage', guard('showUsage', showUsage)),
    vscode.commands.registerCommand('relevo.refreshUsage', guard('refreshUsage', refreshUsage)),
    vscode.commands.registerCommand('relevo.updateUsage', guard('updateUsage', updateUsage)),
    vscode.commands.registerCommand('relevo.setupProfiles', guard('setupProfiles', setupProfilesCommand)),
    vscode.commands.registerCommand('relevo.diagnostics', guard('diagnostics', diagnostics)),
    vscode.commands.registerCommand('relevo.reportProblem', guard('reportProblem', reportProblem)),
    vscode.workspace.onDidChangeConfiguration(onConfigChanged),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        refreshUsage();
      }
    }),
    { dispose: () => timer && clearInterval(timer) },
    { dispose: cancelPending },
  );

  for (const account of accounts.slice(1)) {
    void prepareProfile(account, false);
  }
  renderStatus();
  restartTimer();
  refreshUsage();
  announceSwitch();
  warnOnStartup();
}

export function deactivate(): void {}

// ---------- problems & warnings ----------

/** For logs and reports (always English). */
function kindLabel(kind: vscode.ExtensionKind): string {
  return kind === vscode.ExtensionKind.UI ? 'local' : vscode.env.remoteName ? `remote:${vscode.env.remoteName}` : 'local';
}

function kindName(kind: vscode.ExtensionKind): string {
  return kind === vscode.ExtensionKind.UI || !vscode.env.remoteName ? t('the local machine') : t('the remote ({0})', vscode.env.remoteName);
}

/** Conditions that keep the per-window account from taking effect. */
function problems(): string[] {
  const list: string[] = [];
  const official = vscode.extensions.getExtension(OFFICIAL_ID);
  if (!official) {
    list.push(t('The Claude Code extension (anthropic.claude-code) was not found on this host.'));
  } else if (official.extensionKind !== ctx.extension.extensionKind) {
    list.push(
      t(
        'Claude Code runs on {0} and Relevo on {1}: install Relevo on the same side as Claude Code so it can choose the account.',
        kindName(official.extensionKind),
        kindName(ctx.extension.extensionKind),
      ),
    );
  }
  const env = vscode.workspace.getConfiguration('claudeCode').get<unknown>('environmentVariables');
  const names = Array.isArray(env) ? env.map((e) => e?.name) : env && typeof env === 'object' ? Object.keys(env) : [];
  if (names.some((n) => typeof n === 'string' && n.toUpperCase() === 'CLAUDE_CONFIG_DIR')) {
    list.push(t('claudeCode.environmentVariables sets CLAUDE_CONFIG_DIR, which overrides the account of each window.'));
  }
  return list;
}

/**
 * The account Claude Code actually picked up in this window. When it activates it writes
 * <profile>/ide/<port>.lock listing the window's folders, so the newest lock naming our folders
 * tells which profile it resolved. Locks from before this host started belong to a previous
 * host, so they are ignored. Undefined until the lock exists, or for a folderless window.
 */
function officialAccount(): Account | undefined {
  const own = folders();
  if (own.length === 0) {
    return undefined;
  }
  let best: { account: Account; mtime: number } | undefined;
  for (const account of accounts) {
    const dir = path.join(account.dir, 'ide');
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.lock'));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const file = path.join(dir, name);
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime < HOST_STARTED - 1000) {
          continue;
        }
        const lockFolders: unknown = JSON.parse(fs.readFileSync(file, 'utf8')).workspaceFolders;
        const matches =
          Array.isArray(lockFolders) &&
          lockFolders.length === own.length &&
          own.every((f) => lockFolders.some((l) => typeof l === 'string' && samePath(l, f)));
        if (matches && (!best || mtime > best.mtime)) {
          best = { account, mtime };
        }
      } catch {
        // lock being rewritten or removed
      }
    }
  }
  return best?.account;
}

function warnOnStartup(): void {
  for (const p of problems()) {
    log.warn(`problem: ${p}`);
    const report = t('Report a problem');
    void vscode.window.showWarningMessage(p, report).then((c) => {
        if (c === report) {
          void reportProblem();
        }
      });
  }
  // Claude Code writes its lock shortly after activating; check a few times, warn once.
  let warned = false;
  for (const delay of [5_000, 15_000, 45_000]) {
    const timeout = setTimeout(() => {
      renderStatus();
      const owner = officialAccount();
      if (!warned && !switchingTo && owner && owner !== active) {
        warned = true;
        log.warn(`Claude Code started with account ${owner.id} although the window is on ${active.id}`);
        const restart = t('Restart extensions');
        void vscode.window
          .showWarningMessage(t('Claude Code started with the account {0} in this window, not {1}.', owner.label, active.label), restart)
          .then((c) => c === restart && vscode.commands.executeCommand(RESTART_HOSTS));
      } else if (owner) {
        log.info(`Claude Code confirmed account ${owner.id} (after ${delay / 1000}s)`);
      }
    }, delay);
    ctx.subscriptions.push({ dispose: () => clearTimeout(timeout) });
  }
}

// ---------- status bar ----------

function pct(w: UsageWindow | undefined): string {
  const p = effectivePct(w);
  return p === undefined ? '–' : `${Math.round(p)}%`;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function formatReset(ms: number | undefined): string {
  if (ms === undefined || ms <= Date.now()) {
    return '';
  }
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(language(), sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function historyKey(account: Account): string {
  return account.dir.toLowerCase();
}

/** Today's share of the weekly quota for the active account, spread over the days left until the reset. */
function currentBudget(): Budget | undefined {
  const week = effectivePct(activeUsage?.sevenDay);
  const resetsAt = activeUsage?.sevenDay?.resetsAt;
  if (week === undefined || resetsAt === undefined || resetsAt <= Date.now()) {
    return undefined;
  }
  const samples = history.samples(historyKey(active));
  return dailyBudget(samples, week, resetsAt, Date.now(), pinnedStart(samples, week, resetsAt));
}

/** Today's starting %, worked out once per quota day on this machine and then kept. */
function pinnedStart(samples: Sample[], week: number, resetsAt: number): number {
  return history.dayStartPct(historyKey(active), quotaDayStart(resetsAt), () => {
    const start = dailyBudget(samples, week, resetsAt).startPct;
    log.info(`quota day ${new Date(quotaDayStart(resetsAt)).toISOString()}: start pinned at ${start}% for ${active.id}`);
    return start;
  });
}

function round1(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function budgetText(b: Budget): string {
  const days = b.daysLeft === 1 ? t('the last day') : t('{0} days', b.daysLeft);
  const today =
    b.leftToday >= 0
      ? t('Today you have used {0}% and have ~{1}% left.', round1(b.usedToday), round1(b.leftToday))
      : t('Today you have used {0}%, ~{1}% over: the remaining days will get less.', round1(b.usedToday), round1(-b.leftToday));
  return (
    t("Today's budget: ~{0}% of the weekly quota ({1}% free for {2}, until {3}).", round1(b.allowance), round1(100 - b.startPct), days, formatReset(b.resetsAt)) +
    ' ' +
    today +
    (b.partial ? ' ' + t('Recording started partway through this day, so earlier use is not counted.') : '') +
    ' ' +
    t('The quota day ends {0}.', formatReset(b.todayEnds))
  );
}

/** Claude Code's figures older than this get a hint to refresh them. */
const STALE_MS = 30 * 60_000;

/** How old the figures are: minutes, then whole hours, and past a day just "+1 day". */
function ageText(u: AccountUsage): string {
  const min = Math.floor((Date.now() - u.fetchedAt) / 60_000);
  return min < 60 ? t('{0} min', Math.max(0, min)) : min < 24 * 60 ? t('{0} h', Math.floor(min / 60)) : t('+1 day');
}

function isStale(u: AccountUsage | undefined): boolean {
  return !u || u.source === 'none' || Date.now() - u.fetchedAt > STALE_MS;
}

function sourceText(u: AccountUsage | undefined): string {
  if (!u || u.source === 'none') {
    return t("Claude Code has not stored this account's usage yet");
  }
  return Date.now() - u.fetchedAt >= 86_400_000
    ? t('figures Claude Code stored more than a day ago')
    : t('figures Claude Code stored {0} ago', ageText(u));
}

function buildTooltip(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = {
    enabledCommands: ['relevo.switch', 'relevo.showUsage', 'relevo.updateUsage', 'relevo.reportProblem', RESTART_HOSTS],
  };
  const info = readAccountInfo(active);
  md.appendMarkdown(`**${escapeMd(t('This window uses the account {0}', active.label))}**${info.email ? ` (${escapeMd(info.email)})` : ''}\n\n`);
  md.appendMarkdown(`| | ${t('Usage')} | ${t('Resets')} |\n|:--|--:|:--|\n`);
  md.appendMarkdown(`| ${t('5 hours')} | ${pct(activeUsage?.fiveHour)} | ${escapeMd(formatReset(activeUsage?.fiveHour?.resetsAt))} |\n`);
  md.appendMarkdown(`| ${t('Weekly')} | ${pct(activeUsage?.sevenDay)} | ${escapeMd(formatReset(activeUsage?.sevenDay?.resetsAt))} |\n\n`);
  const budget = currentBudget();
  if (budget) {
    md.appendMarkdown(`${budget.leftToday >= 0 ? '$(calendar)' : '$(warning)'} ${escapeMd(budgetText(budget))}\n\n`);
  }
  md.appendMarkdown(escapeMd(t('Source: {0}.', sourceText(activeUsage))));
  if (isStale(activeUsage)) {
    md.appendMarkdown(' ' + escapeMd(t('Click the usage to refresh it.')));
  }
  md.appendMarkdown('\n\n');
  for (const p of problems()) {
    md.appendMarkdown(`$(warning) ${escapeMd(p)}\n\n`);
  }
  const owner = officialAccount();
  const restartLink = `[${t('Restart extensions')}](command:${RESTART_HOSTS})`;
  if (stale) {
    md.appendMarkdown(`$(warning) ${escapeMd(t('The account settings changed.'))} ${restartLink}\n\n`);
  } else if (owner && owner !== active) {
    md.appendMarkdown(`$(warning) ${escapeMd(t('Claude Code in this window started with the account {0}.', owner.label))} ${restartLink}\n\n`);
  } else if (owner) {
    md.appendMarkdown(`$(pass) ${escapeMd(t('Claude Code confirmed the account {0} in this window.', owner.label))}\n\n`);
  }
  md.appendMarkdown(
    [
      `[${t('Switch account')}](command:relevo.switch)`,
      `[${t('Usage panel')}](command:relevo.showUsage)`,
      `[${t('Refresh usage')}](command:relevo.updateUsage)`,
      `[${t('Report a problem')}](command:relevo.reportProblem)`,
    ].join(' · '),
  );
  return md;
}

function renderStatus(): void {
  const tooltip = buildTooltip();
  const owner = officialAccount();
  const warn = problems().length > 0 || stale || (owner !== undefined && owner !== active);
  if (switchingTo) {
    accountItem.text = `$(sync~spin) Claude: ${active.label} → ${switchingTo.label}…`;
  } else if (pending) {
    accountItem.text = `$(sync~spin) Claude: ${active.label} → ${pending.target.label} ${t('when done')}`;
  } else {
    accountItem.text = `${warn ? '$(warning)' : '$(account)'} Claude: ${active.label}`;
  }
  accountItem.tooltip = tooltip;
  accountItem.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  accountItem.show();

  if (config().get<string>('statusBarUsage') === 'off') {
    usageItem.hide();
    return;
  }
  const budget = currentBudget();
  const today = budget ? ` · ${t('today')} ${round1(budget.usedToday)}/${round1(budget.allowance)}%` : '';
  // Always shown, so it's clear how fresh the figures are; a click refreshes them.
  const age = ` · $(history) ${activeUsage && activeUsage.source !== 'none' ? ageText(activeUsage) : '–'}`;
  const icon = updating ? '$(sync~spin)' : '$(graph-line)';
  usageItem.text = `${icon} 5h ${pct(activeUsage?.fiveHour)} · ${t('wk')} ${pct(activeUsage?.sevenDay)}${today}${age}`;
  usageItem.tooltip = tooltip;
  const worst = Math.max(effectivePct(activeUsage?.fiveHour) ?? 0, effectivePct(activeUsage?.sevenDay) ?? 0);
  const overToday = budget !== undefined && budget.leftToday < 0;
  usageItem.backgroundColor =
    worst >= 90 ? new vscode.ThemeColor('statusBarItem.errorBackground') : worst >= 75 || overToday ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  usageItem.show();
}

function claudeBinary(): string {
  const official = vscode.extensions.getExtension(OFFICIAL_ID);
  if (official) {
    const exe = path.join(official.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(exe)) {
      return exe;
    }
  }
  return 'claude';
}

/**
 * On the user's request only: runs Claude Code's own /usage command for this window's account, so
 * Claude Code fetches the figures with its own sign-in and stores them; then re-reads them.
 * Relevo never touches the credentials and never runs this on a timer.
 */
async function updateUsage(): Promise<void> {
  if (updating) {
    return;
  }
  updating = true;
  renderStatus();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (active.envValue === undefined) {
    delete env.CLAUDE_CONFIG_DIR;
  } else {
    env.CLAUDE_CONFIG_DIR = active.envValue;
  }
  const before = activeUsage?.fetchedAt ?? 0;
  const binary = claudeBinary();
  const started = Date.now();
  log.info(`refresh usage: running Claude Code /usage for ${active.id} (${path.basename(binary)})`);
  try {
    await new Promise<void>((resolve, reject) => {
      cp.execFile(binary, ['-p', '/usage'], { env, cwd: os.tmpdir(), timeout: 90_000, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`${err.message}${stderr ? ` | ${String(stderr).trim().split('\n')[0]}` : ''}`));
        } else {
          resolve();
        }
      });
    });
    log.info(`refresh usage: /usage finished in ${Date.now() - started} ms`);
  } catch (e) {
    log.error(`refresh usage: /usage failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    updating = false;
  }
  refreshUsage();
  if ((activeUsage?.fetchedAt ?? 0) <= before) {
    log.warn('refresh usage: Claude Code did not store new figures');
    const report = t('Report a problem');
    void vscode.window
      .showWarningMessage(t('Claude Code did not update the usage. Try typing /usage in Claude Code.'), report)
      .then((c) => {
        if (c === report) {
          void reportProblem();
        }
      });
  }
}

/** Re-reads the usage Claude Code stored for the active account and records it in the history. */
function refreshUsage(): void {
  try {
    activeUsage = readUsage(active);
    history.record(historyKey(active), activeUsage);
  } catch (e) {
    log.error(`reading usage of ${active.id}: ${e}`);
  }
  renderStatus();
}

function restartTimer(): void {
  if (timer) {
    clearInterval(timer);
  }
  timer = setInterval(refreshUsage, intervalMs());
}

function onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
  if (e.affectsConfiguration(`${SECTION}.language`)) {
    applyLanguage();
    accountItem.name = t('Claude: account');
    usageItem.name = t('Claude: usage');
    log.info(`language: ${language()}`);
  }
  if (e.affectsConfiguration(SECTION)) {
    accounts = loadAccounts();
    const current = accounts.find((a) => a.id === active.id);
    if (current) {
      active = current;
    } else {
      // The account this window was using no longer exists in the list.
      active = selectedAccount();
    }
    const applied = process.env.CLAUDE_CONFIG_DIR || undefined;
    if (active.envValue !== applied) {
      stale = true;
      applyAccount(active);
      log.info(`accounts setting changed: window now on ${active.id}, restart pending`);
      const restart = t('Restart extensions');
      void vscode.window
        .showInformationMessage(t('The account settings changed. Restart the extensions so Claude Code uses the account {0}.', active.label), restart)
        .then((c) => c === restart && vscode.commands.executeCommand(RESTART_HOSTS));
    }
    restartTimer();
    refreshUsage();
  }
  if (e.affectsConfiguration(SECTION) || e.affectsConfiguration('claudeCode.environmentVariables')) {
    renderStatus();
  }
}

// ---------- choosing and switching ----------

type PickItem = vscode.QuickPickItem & { run?: () => unknown };

async function chooseAccount(): Promise<void> {
  const items: PickItem[] = [];
  if (pending) {
    items.push({ label: `$(close) ${t('Cancel the switch to {0}', pending.target.label)}`, description: t('Claude is still answering'), run: cancelPendingAndRender });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }
  for (const a of accounts) {
    const info = readAccountInfo(a);
    items.push({
      label: `${a === active ? '$(check) ' : ''}${a.label}`,
      description: info.email ?? (info.loggedIn ? '' : t('not signed in: Claude Code will ask you to sign in')),
      detail: a === active ? t('In use in this window') : undefined,
      run: () => switchTo(a),
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: `$(add) ${t('Add account…')}`, run: addAccount });
  if (accounts.some((a) => a !== primaryAccount() && a !== active)) {
    items.push({ label: `$(trash) ${t('Remove an account from the list…')}`, run: removeAccount });
  }
  items.push({ label: `$(graph) ${t('Usage panel')}`, run: showUsage });
  items.push({ label: `$(bug) ${t('Report a problem…')}`, run: reportProblem });

  const picked = await vscode.window.showQuickPick(items, {
    title: t('Claude account for this window'),
    placeHolder: t("Picking another account restarts this window's extensions; your files and terminals stay open"),
    matchOnDescription: true,
  });
  await picked?.run?.();
}

function switchToId(id: string): Promise<void> {
  const target = accounts.find((a) => a.id.toLowerCase() === id.toLowerCase());
  return target ? switchTo(target) : Promise.resolve();
}

function cancelPending(): void {
  if (pending) {
    clearInterval(pending.timer);
    pending = undefined;
  }
}

function cancelPendingAndRender(): void {
  log.info('pending switch cancelled');
  cancelPending();
  renderStatus();
}

async function switchTo(target: Account): Promise<void> {
  cancelPending();
  if (target === active || switchingTo) {
    renderStatus();
    return;
  }
  // Restarting the extension host ends the Claude process mid-answer, so never do it then.
  const working = workingSessions(active, folders());
  if (working.length > 0) {
    log.info(`switch to ${target.id} held: ${working.length} session(s) working (${working.map((s) => s.status).join(', ')})`);
    const later = t('Switch when it finishes');
    const choice = await vscode.window.showWarningMessage(
      t('Claude is answering in this window. Switching to {0} now would cut the answer short.', target.label),
      later,
      t('Cancel'),
    );
    if (choice === later) {
      waitForIdle(target);
    }
    return;
  }
  await performSwitch(target);
}

function waitForIdle(target: Account): void {
  cancelPending();
  log.info(`waiting for Claude to finish before switching to ${target.id}`);
  const entry: PendingSwitch = {
    target,
    idleTicks: 0,
    timer: setInterval(() => {
      // Two quiet checks in a row, so a gap between tool calls doesn't count as finished.
      entry.idleTicks = workingSessions(active, folders()).length === 0 ? entry.idleTicks + 1 : 0;
      if (entry.idleTicks >= 2) {
        cancelPending();
        void performSwitch(target);
      }
    }, 2000),
  };
  pending = entry;
  renderStatus();
}

async function performSwitch(target: Account): Promise<void> {
  if (!(await prepareProfile(target, true))) {
    renderStatus();
    return;
  }
  switchingTo = target;
  renderStatus();
  log.info(`switching ${active.id} -> ${target.id}; restarting the extension host`);
  await ctx.workspaceState.update(STATE_KEY, target.id);
  await ctx.workspaceState.update(SWITCHED_KEY, { to: target.id, at: Date.now() });
  // Restart only after the command that asked for it (a status bar click, the picker) has returned.
  // Otherwise VS Code sees that command die with the host and shows a "Canceled" error.
  setTimeout(() => {
    vscode.commands.executeCommand(RESTART_HOSTS).then(undefined, (e) => {
      // Rejected as "Canceled" at the moment this very host is stopped: that is the restart working.
      if ((e as Error)?.name === 'Canceled' || /Canceled/.test(String(e))) {
        return;
      }
      log.error(`could not restart the extension host: ${e}`);
      switchingTo = undefined;
      const reload = t('Reload window');
      void vscode.window
        .showErrorMessage(t('Could not restart the extensions. Reload the window to use the other account.'), reload)
        .then((c) => c === reload && vscode.commands.executeCommand('workbench.action.reloadWindow'));
      renderStatus();
    });
  }, 100);
}

/** Runs in the new extension host right after a switch: confirms it, or explains what happens next. */
function announceSwitch(): void {
  const mark = ctx.workspaceState.get<{ to: string; at: number }>(SWITCHED_KEY);
  if (!mark) {
    return;
  }
  void ctx.workspaceState.update(SWITCHED_KEY, undefined);
  if (mark.to !== active.id || Date.now() - mark.at > 120_000) {
    return;
  }
  const signedIn = readAccountInfo(active).loggedIn;
  log.info(`switch to ${active.id} completed in ${Date.now() - mark.at} ms; signed in: ${signedIn}`);
  if (signedIn) {
    vscode.window.setStatusBarMessage(`$(check) ${t('Claude: now using the account {0}', active.label)}`, 6000);
    return;
  }
  const open = t('Open Claude');
  void vscode.window
    .showInformationMessage(
      t(
        'The account "{0}" is not signed in yet. Claude Code will show its sign-in form: open the link, authorize with that claude.ai account and paste the code here if asked. If your browser is signed in to another account, use a private window.',
        active.label,
      ),
      open,
    )
    .then((c) => c === open && vscode.commands.executeCommand('claude-vscode.editor.open'));
}

// ---------- adding and removing accounts ----------

function configuredAccounts(): AccountConfig[] {
  const list = config().get<AccountConfig[]>('accounts') ?? [];
  return list.length > 0 ? list : defaultAccountConfigs();
}

async function addAccount(): Promise<void> {
  const current = configuredAccounts();
  const name = await vscode.window.showInputBox({
    title: t('Add a Claude account'),
    prompt: t('A name to recognize it, e.g. "Work". When you pick it, Claude Code will ask you to sign in.'),
    placeHolder: t('Work'),
    validateInput: (v) => {
      const r = newAccountConfig(current, v);
      return 'error' in r ? r.error : undefined;
    },
  });
  if (name === undefined) {
    return;
  }
  const created = newAccountConfig(current, name);
  if ('error' in created) {
    return;
  }
  await config().update('accounts', [...current, created.config], vscode.ConfigurationTarget.Global);
  accounts = loadAccounts();
  const target = accounts.find((a) => a.id === created.config.id);
  if (!target) {
    return;
  }
  log.info(`account added: ${target.id}`);
  fs.mkdirSync(target.dir, { recursive: true });
  // A new account starts with the same model, effort and permissions as the first one.
  if (canCopySettings(primaryAccount(), target)) {
    copySettings(primaryAccount(), target);
    log.info(`${target.id}: settings.json copied from ${primaryAccount().id}`);
  }
  await switchTo(target);
}

async function removeAccount(): Promise<void> {
  const removable = accounts.filter((a) => a !== primaryAccount() && a !== active);
  if (removable.length === 0) {
    void vscode.window.showInformationMessage(t('There are no accounts to remove: the first one and the one this window uses stay.'));
    return;
  }
  const picked = await vscode.window.showQuickPick(
    removable.map((a) => ({ label: a.label, description: readAccountInfo(a).email ?? '', detail: a.dir, account: a })),
    { title: t('Remove an account from the list'), placeHolder: t('Pick the account to remove') },
  );
  if (!picked) {
    return;
  }
  const remove = t('Remove');
  const choice = await vscode.window.showWarningMessage(
    t('Remove the account "{0}" from the list?', picked.account.label),
    {
      modal: true,
      detail: t('Nothing is deleted: its folder ({0}) and sign-in stay there. Add it again with the same name to get everything back.', picked.account.dir),
    },
    remove,
  );
  if (choice === remove) {
    await config().update('accounts', configuredAccounts().filter((c) => c.id !== picked.account.id), vscode.ConfigurationTarget.Global);
    log.info(`account removed from the list: ${picked.account.id}`);
  }
}

// ---------- profiles ----------

/**
 * Links the account's shared folders to the primary profile's. Non-interactive runs only fix
 * the safe cases; interactive ones may ask to merge a folder that already has content.
 * Returns false when the user cancelled.
 */
async function prepareProfile(account: Account, interactive: boolean): Promise<boolean> {
  const primary = primaryAccount();
  if (samePath(account.dir, primary.dir) || (!interactive && !fs.existsSync(account.dir))) {
    return true;
  }
  const names = config().get<string[]>('sharedFolders', ['projects']);
  try {
    let statuses = ensureSharedFolders(primary, account, names, false);
    const pendingMerge = statuses.filter((s) => s.state === 'non-empty-dir');
    if (pendingMerge.length > 0 && interactive) {
      const merge = t('Merge and link');
      const skip = t('Continue without linking');
      const choice = await vscode.window.showWarningMessage(
        t('{0} already has content.', pendingMerge.map((p) => p.link).join(', ')),
        { modal: true, detail: t('Move it to {0} and leave a link, so both accounts share history? If a file exists in both, both are kept.', primary.dir) },
        merge,
        skip,
      );
      if (choice === undefined) {
        return false;
      }
      if (choice === merge) {
        const merged = ensureSharedFolders(primary, account, pendingMerge.map((p) => p.name), true);
        statuses = statuses.map((s) => merged.find((m) => m.name === s.name) ?? s);
      }
    }
    for (const s of statuses) {
      const line = `${account.id}: ${s.name} link ${s.state}`;
      if (s.state === 'foreign-link' || s.state === 'not-a-dir') {
        log.warn(line);
        if (interactive) {
          void vscode.window.showWarningMessage(t("{0} doesn't point to {1}; left untouched.", s.link, s.target));
        }
      } else {
        log.info(line);
      }
    }
    if (alignCleanupPeriod(primary, account)) {
      log.info(`${account.id}: cleanupPeriodDays aligned with ${primary.id} (shared history)`);
    }
  } catch (e) {
    log.error(`could not prepare profile ${account.id}: ${e}`);
    if (interactive) {
      void vscode.window.showErrorMessage(t('Could not prepare the profile {0}: {1}', account.label, e instanceof Error ? e.message : String(e)));
    }
  }
  return true;
}

async function setupProfilesCommand(): Promise<void> {
  for (const account of accounts.slice(1)) {
    fs.mkdirSync(account.dir, { recursive: true });
    if (!(await prepareProfile(account, true))) {
      return;
    }
  }
  diagnostics();
}

// ---------- usage view ----------

/** The active account's weekly window cut into quota days, for the panel. */
function quotaInfo(): PanelData['quota'] {
  const week = effectivePct(activeUsage?.sevenDay);
  const resetsAt = activeUsage?.sevenDay?.resetsAt;
  if (week === undefined || resetsAt === undefined || resetsAt <= Date.now()) {
    return undefined;
  }
  const samples = history.samples(historyKey(active));
  const start = pinnedStart(samples, week, resetsAt);
  return {
    account: active.id,
    days: quotaDays(samples, week, resetsAt, Date.now(), start),
    budget: dailyBudget(samples, week, resetsAt, Date.now(), start),
    used7d: usedSince(samples, Date.now() - 7 * 86_400_000),
    recordedSince: samples[0]?.t,
  };
}

function showUsage(): void {
  UsagePanel.show(ctx.extensionUri, t('Claude usage'), async (): Promise<PanelData> => {
    refreshUsage();
    const scan = await scanTranscripts(accounts, SCAN_DAYS);
    log.info(`usage panel: ${scan.files} files, ${scan.records.length} buckets, ${scan.ms} ms`);
    return {
      generatedAt: Date.now(),
      lang: language(),
      l10n: translations(),
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        email: readAccountInfo(a).email,
        active: a === active,
        usage: a === active ? activeUsage : undefined,
      })),
      records: scan.records,
      quota: quotaInfo(),
      files: scan.files,
      ms: scan.ms,
    };
  });
}

// ---------- diagnostics & problem reports ----------

/** The state of this window, in English, for the log and for problem reports. */
function stateLines(): string[] {
  const official = vscode.extensions.getExtension(OFFICIAL_ID);
  const budget = currentBudget();
  const lines = [
    `Relevo ${ctx.extension.packageJSON.version} on ${kindLabel(ctx.extension.extensionKind)} (pid ${process.pid})`,
    `VS Code ${vscode.version} · ${process.platform} ${os.release()} ${process.arch} · remote: ${vscode.env.remoteName ?? 'none'} · UI language: ${vscode.env.language} · Relevo language: ${language()}`,
    official
      ? `Claude Code ${official.packageJSON.version} on ${kindLabel(official.extensionKind)}, active=${official.isActive}`
      : 'Claude Code: not found on this host',
    `window account: ${active.id}${stale ? ' (settings changed, restart pending)' : ''}${switchingTo ? ` (switching to ${switchingTo.id})` : ''}${pending ? ` (waiting to switch to ${pending.target.id})` : ''}`,
    `account Claude Code picked up (its ide lock): ${officialAccount()?.id ?? 'not confirmed'}`,
    `CLAUDE_CONFIG_DIR now: ${process.env.CLAUDE_CONFIG_DIR ?? 'unset'} · at start: ${baseConfigDirEnv() ?? 'unset'}`,
    `usage: ${activeUsage?.source ?? 'none'}, 5h=${pct(activeUsage?.fiveHour)}, week=${pct(activeUsage?.sevenDay)}, age=${activeUsage && activeUsage.source !== 'none' ? `${Math.round((Date.now() - activeUsage.fetchedAt) / 60000)} min` : '-'}`,
    budget
      ? `budget: start=${budget.startPct}% allowance=${round1(budget.allowance)}% used today=${round1(budget.usedToday)}% days left=${budget.daysLeft} partial=${budget.partial}`
      : 'budget: -',
    `history samples for ${active.id}: ${history.samples(historyKey(active)).length}`,
    `working sessions in this window: ${workingSessions(active, folders()).length}`,
    `workspace folders: ${folders().length}`,
  ];
  const primary = primaryAccount();
  for (const a of accounts) {
    const info = readAccountInfo(a);
    lines.push(`account ${a.id}: ${a.dir} · CLAUDE_CONFIG_DIR=${a.envValue ?? 'unset'} · signed in=${info.loggedIn} · label ${a.label === a.id ? 'default' : 'set'}`);
    if (a !== primary) {
      for (const name of config().get<string[]>('sharedFolders', ['projects'])) {
        lines.push(`   ${name}: ${linkStatus(primary, a, name).state}`);
      }
    }
  }
  for (const p of problems()) {
    lines.push(`PROBLEM: ${p}`);
  }
  return lines;
}

function diagnostics(): void {
  log.info('--- diagnostics ---');
  for (const line of stateLines()) {
    log.info(line);
  }
  log.show(true);
}

/** The latest lines of this extension's log file(s) for this window. */
function recentLog(): string[] {
  const dir = ctx.logUri.fsPath;
  const lines: string[] = [];
  try {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort()) {
      lines.push(...fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).filter(Boolean));
    }
  } catch {
    // no log file yet
  }
  return lines.slice(-REPORT_LOG_LINES);
}

/**
 * Builds a report a tester can send: what they were doing, versions, this window's state and the
 * recent log, with names, emails and paths masked. It opens as a document to review before
 * sharing, and can be saved or copied.
 */
async function reportProblem(): Promise<void> {
  log.info('--- problem report requested ---');
  for (const line of stateLines()) {
    log.info(line);
  }
  let user: string | undefined;
  try {
    user = os.userInfo().username;
  } catch {
    // not available on this platform
  }
  const redact = makeRedactor({ home: os.homedir(), username: user, hostname: os.hostname(), folders: folders() });
  const body = [
    '# Relevo problem report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## What happened',
    '',
    '<!-- What were you doing, what did you expect, and what happened instead? Screenshots help too. -->',
    '',
    '',
    '## State',
    '',
    '```',
    ...stateLines(),
    '```',
    '',
    `## Log (last ${REPORT_LOG_LINES} lines)`,
    '',
    '```',
    ...recentLog(),
    '```',
    '',
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: redact(body) });
  await vscode.window.showTextDocument(doc);
  const save = t('Save…');
  const copy = t('Copy');
  const choice = await vscode.window.showInformationMessage(
    t('Problem report ready. Add what happened at the top, then save or copy it and send it. Emails, user and machine names and folder paths are masked.'),
    save,
    copy,
  );
  if (choice === copy) {
    await vscode.env.clipboard.writeText(doc.getText());
  } else if (choice === save) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `relevo-report-${stamp}.md`)),
      filters: { Markdown: ['md'] },
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(doc.getText(), 'utf8'));
    }
  }
}
