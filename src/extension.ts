import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Account, AccountConfig, baseConfigDirEnv, defaultAccountConfigs, newAccountConfig, resolveAccounts, samePath } from './accounts';
import { PanelData, UsagePanel } from './panel';
import { alignCleanupPeriod, canCopySettings, copySettings, ensureSharedFolders, linkStatus } from './profiles';
import { Budget, UsageHistory, dailyBudget, quotaDays, usedSince } from './history';
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
  terminals.description = `Claude: cuenta ${account.label}`;
  if (account.envValue === undefined || account.envValue === baseConfigDirEnv()) {
    terminals.clear();
  } else {
    terminals.replace('CLAUDE_CONFIG_DIR', account.envValue);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Keep this block synchronous and first: Claude Code must see the account in process.env
  // before it activates, which is why the publisher id sorts ahead of "anthropic".
  ctx = context;
  accounts = loadAccounts();
  active = selectedAccount();
  applyAccount(active);

  log = vscode.window.createOutputChannel('Relevo', { log: true });
  context.subscriptions.push(log);
  log.info(`ventana en cuenta ${active.id} (CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? 'sin definir'})`);
  history = new UsageHistory(context.globalStorageUri.fsPath);

  accountItem = vscode.window.createStatusBarItem('relevo.account', vscode.StatusBarAlignment.Right, 101);
  accountItem.name = 'Claude: cuenta';
  accountItem.command = 'relevo.switch';
  usageItem = vscode.window.createStatusBarItem('relevo.usage', vscode.StatusBarAlignment.Right, 100);
  usageItem.name = 'Claude: % de uso';
  // Clicking the usage asks Claude Code for fresh figures; the panel opens from the tooltip.
  usageItem.command = 'relevo.updateUsage';
  context.subscriptions.push(accountItem, usageItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('relevo.switch', (id?: unknown) => (typeof id === 'string' ? switchToId(id) : chooseAccount())),
    vscode.commands.registerCommand('relevo.addAccount', addAccount),
    vscode.commands.registerCommand('relevo.removeAccount', removeAccount),
    vscode.commands.registerCommand('relevo.showUsage', showUsage),
    vscode.commands.registerCommand('relevo.refreshUsage', refreshUsage),
    vscode.commands.registerCommand('relevo.updateUsage', updateUsage),
    vscode.commands.registerCommand('relevo.setupProfiles', setupProfilesCommand),
    vscode.commands.registerCommand('relevo.diagnostics', diagnostics),
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

function kindName(kind: vscode.ExtensionKind): string {
  return kind === vscode.ExtensionKind.UI ? 'el equipo local' : vscode.env.remoteName ? `el remoto (${vscode.env.remoteName})` : 'el equipo local';
}

/** Conditions that keep the per-window account from taking effect. */
function problems(): string[] {
  const list: string[] = [];
  const official = vscode.extensions.getExtension(OFFICIAL_ID);
  if (!official) {
    list.push('No encontré la extensión Claude Code (anthropic.claude-code) en este host.');
  } else if (official.extensionKind !== ctx.extension.extensionKind) {
    list.push(
      `Claude Code corre en ${kindName(official.extensionKind)} y este switcher en ${kindName(ctx.extension.extensionKind)}: ` +
        'instala el switcher en el mismo lado que Claude Code para que pueda elegir la cuenta.',
    );
  }
  const env = vscode.workspace.getConfiguration('claudeCode').get<unknown>('environmentVariables');
  const names = Array.isArray(env) ? env.map((e) => e?.name) : env && typeof env === 'object' ? Object.keys(env) : [];
  if (names.some((n) => typeof n === 'string' && n.toUpperCase() === 'CLAUDE_CONFIG_DIR')) {
    list.push('claudeCode.environmentVariables define CLAUDE_CONFIG_DIR, y eso tiene prioridad sobre la cuenta de cada ventana.');
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
    void vscode.window.showWarningMessage(p, 'Diagnóstico').then((c) => c && diagnostics());
  }
  // Claude Code writes its lock shortly after activating; check a few times, warn once.
  let warned = false;
  for (const delay of [5_000, 15_000, 45_000]) {
    const t = setTimeout(() => {
      renderStatus();
      const owner = officialAccount();
      if (!warned && !switchingTo && owner && owner !== active) {
        warned = true;
        log.warn(`Claude Code arrancó con la cuenta ${owner.id} aunque la ventana está en ${active.id}`);
        void vscode.window
          .showWarningMessage(`Claude Code arrancó con la cuenta ${owner.label} en esta ventana, no con ${active.label}.`, 'Reiniciar extensiones')
          .then((c) => c && vscode.commands.executeCommand(RESTART_HOSTS));
      }
    }, delay);
    ctx.subscriptions.push({ dispose: () => clearTimeout(t) });
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
  return d.toLocaleString('es', sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  return dailyBudget(history.samples(historyKey(active)), week, resetsAt);
}

function round1(n: number): string {
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function budgetText(b: Budget): string {
  const days = b.daysLeft === 1 ? 'el último día' : `${b.daysLeft} días`;
  const today =
    b.leftToday >= 0
      ? `Hoy llevas ${round1(b.usedToday)}% y te quedan ~${round1(b.leftToday)}%.`
      : `Hoy llevas ${round1(b.usedToday)}%, ~${round1(-b.leftToday)}% por encima: los días que quedan tendrán menos.`;
  return (
    `Presupuesto de hoy: ~${round1(b.allowance)}% de la cuota semanal (${round1(100 - b.startPct)}% libre para ${days}, hasta el ${formatReset(b.resetsAt)}). ` +
    today +
    (b.partial ? ' El registro empezó a mitad de este día, así que lo usado antes no cuenta.' : '') +
    ` El día de cuota termina ${formatReset(b.todayEnds)}.`
  );
}

/** Claude Code's figures older than this are flagged, with a hint to refresh them with /usage. */
const STALE_MS = 30 * 60_000;

/** How old the figures are: minutes, then whole hours, and past a day just "+1 día". */
function ageText(u: AccountUsage): string {
  const min = Math.floor((Date.now() - u.fetchedAt) / 60_000);
  return min < 60 ? `${Math.max(0, min)} min` : min < 24 * 60 ? `${Math.floor(min / 60)} h` : '+1 día';
}

function isStale(u: AccountUsage | undefined): boolean {
  return !u || u.source === 'none' || Date.now() - u.fetchedAt > STALE_MS;
}

function sourceText(u: AccountUsage | undefined): string {
  if (!u || u.source === 'none') {
    return 'Claude Code todavía no guardó el uso de esta cuenta';
  }
  const age = ageText(u);
  return `dato que guardó Claude Code ${age === '+1 día' ? 'hace más de un día' : `hace ${age}`}`;
}

function buildTooltip(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = {
    enabledCommands: ['relevo.switch', 'relevo.showUsage', 'relevo.updateUsage', 'relevo.diagnostics', RESTART_HOSTS],
  };
  const info = readAccountInfo(active);
  md.appendMarkdown(`**Esta ventana usa la cuenta ${escapeMd(active.label)}**${info.email ? ` (${escapeMd(info.email)})` : ''}\n\n`);
  md.appendMarkdown('| | Uso | Se reinicia |\n|:--|--:|:--|\n');
  md.appendMarkdown(`| 5 horas | ${pct(activeUsage?.fiveHour)} | ${escapeMd(formatReset(activeUsage?.fiveHour?.resetsAt))} |\n`);
  md.appendMarkdown(`| Semanal | ${pct(activeUsage?.sevenDay)} | ${escapeMd(formatReset(activeUsage?.sevenDay?.resetsAt))} |\n\n`);
  const budget = currentBudget();
  if (budget) {
    md.appendMarkdown(`${budget.leftToday >= 0 ? '$(calendar)' : '$(warning)'} ${escapeMd(budgetText(budget))}\n\n`);
  }
  md.appendMarkdown(`${escapeMd(`Fuente: ${sourceText(activeUsage)}.`)}`);
  if (isStale(activeUsage)) {
    md.appendMarkdown(' Haz clic en el uso para actualizarlo.');
  }
  md.appendMarkdown('\n\n');
  for (const p of problems()) {
    md.appendMarkdown(`$(warning) ${escapeMd(p)}\n\n`);
  }
  const owner = officialAccount();
  if (stale) {
    md.appendMarkdown(`$(warning) Cambió la configuración de cuentas. [Reiniciar extensiones](command:${RESTART_HOSTS}) para aplicarla.\n\n`);
  } else if (owner && owner !== active) {
    md.appendMarkdown(`$(warning) Claude Code en esta ventana arrancó con la cuenta ${escapeMd(owner.label)}. [Reiniciar extensiones](command:${RESTART_HOSTS})\n\n`);
  } else if (owner) {
    md.appendMarkdown(`$(pass) Claude Code confirmó la cuenta ${escapeMd(owner.label)} en esta ventana.\n\n`);
  }
  md.appendMarkdown(
    '[Cambiar cuenta](command:relevo.switch) · [Ver consumo](command:relevo.showUsage) · ' +
      '[Actualizar uso](command:relevo.updateUsage) · [Diagnóstico](command:relevo.diagnostics)',
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
    accountItem.text = `$(sync~spin) Claude: ${active.label} → ${pending.target.label} al terminar`;
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
  const today = budget ? ` · hoy ${round1(budget.usedToday)}/${round1(budget.allowance)}%` : '';
  // Always shown, so it's clear how fresh the figures are; a click refreshes them.
  const age = ` · $(history) ${activeUsage && activeUsage.source !== 'none' ? ageText(activeUsage) : '–'}`;
  const icon = updating ? '$(sync~spin)' : '$(graph-line)';
  usageItem.text = `${icon} 5h ${pct(activeUsage?.fiveHour)} · sem ${pct(activeUsage?.sevenDay)}${today}${age}`;
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
  try {
    await new Promise<void>((resolve, reject) => {
      cp.execFile(claudeBinary(), ['-p', '/usage'], { env, cwd: os.tmpdir(), timeout: 90_000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    log.error(`/usage de Claude Code falló: ${e}`);
  } finally {
    updating = false;
  }
  refreshUsage();
  if ((activeUsage?.fetchedAt ?? 0) <= before) {
    void vscode.window.showWarningMessage('Claude Code no actualizó el uso. Prueba escribiendo /usage en Claude Code.', 'Diagnóstico').then((c) => c && diagnostics());
  }
}

/** Re-reads the usage Claude Code stored for the active account and records it in the history. */
function refreshUsage(): void {
  try {
    activeUsage = readUsage(active);
    history.record(historyKey(active), activeUsage);
  } catch (e) {
    log.error(`uso de ${active.id}: ${e}`);
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
      void vscode.window
        .showInformationMessage(`La configuración de cuentas cambió. Reinicia las extensiones para que Claude Code use la cuenta ${active.label}.`, 'Reiniciar extensiones')
        .then((c) => c && vscode.commands.executeCommand(RESTART_HOSTS));
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
    items.push({ label: `$(close) Cancelar el cambio a ${pending.target.label}`, description: 'Claude sigue respondiendo', run: cancelPendingAndRender });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }
  for (const a of accounts) {
    const info = readAccountInfo(a);
    items.push({
      label: `${a === active ? '$(check) ' : ''}${a.label}`,
      description: info.email ?? (info.loggedIn ? '' : 'sin sesión: Claude Code te pedirá iniciarla'),
      detail: a === active ? 'En uso en esta ventana' : undefined,
      run: () => switchTo(a),
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(add) Añadir cuenta…', run: addAccount });
  if (accounts.some((a) => a !== primaryAccount() && a !== active)) {
    items.push({ label: '$(trash) Quitar una cuenta de la lista…', run: removeAccount });
  }
  items.push({ label: '$(graph) Ver consumo', run: showUsage });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Cuenta de Claude para esta ventana',
    placeHolder: 'Al elegir otra cuenta se reinician las extensiones de esta ventana; tus archivos y terminales no se cierran',
    matchOnDescription: true,
  });
  await picked?.run?.();
}

function switchToId(id: string): Promise<void> {
  const target = accounts.find((a) => a.id === id);
  return target ? switchTo(target) : Promise.resolve();
}

function cancelPending(): void {
  if (pending) {
    clearInterval(pending.timer);
    pending = undefined;
  }
}

function cancelPendingAndRender(): void {
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
  if (workingSessions(active, folders()).length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Claude está respondiendo en esta ventana. Si cambias a ${target.label} ahora, se cortaría la respuesta.`,
      'Cambiar cuando termine',
      'Cancelar',
    );
    if (choice === 'Cambiar cuando termine') {
      waitForIdle(target);
    }
    return;
  }
  await performSwitch(target);
}

function waitForIdle(target: Account): void {
  cancelPending();
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
  log.info(`cambiando de ${active.id} a ${target.id}; se reinician las extensiones`);
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
      log.error(`no se pudo reiniciar las extensiones: ${e}`);
      switchingTo = undefined;
      void vscode.window
        .showErrorMessage('No se pudo reiniciar las extensiones. Recarga la ventana para usar la otra cuenta.', 'Recargar ventana')
        .then((c) => c && vscode.commands.executeCommand('workbench.action.reloadWindow'));
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
  if (readAccountInfo(active).loggedIn) {
    vscode.window.setStatusBarMessage(`$(check) Claude: ahora usas la cuenta ${active.label}`, 6000);
    return;
  }
  void vscode.window
    .showInformationMessage(
      `La cuenta «${active.label}» todavía no tiene sesión. Claude Code te mostrará su formulario de inicio de sesión: abre el enlace, autoriza con esa cuenta de claude.ai y pega aquí el código si te lo pide. ` +
        'Si tu navegador tiene abierta otra cuenta, usa una ventana de incógnito.',
      'Abrir Claude',
    )
    .then((c) => c && vscode.commands.executeCommand('claude-vscode.editor.open'));
}

// ---------- adding and removing accounts ----------

function configuredAccounts(): AccountConfig[] {
  const list = config().get<AccountConfig[]>('accounts') ?? [];
  return list.length > 0 ? list : defaultAccountConfigs();
}

async function addAccount(): Promise<void> {
  const current = configuredAccounts();
  const name = await vscode.window.showInputBox({
    title: 'Añadir cuenta de Claude',
    prompt: 'Un nombre para reconocerla, por ejemplo «Trabajo». Al elegirla, Claude Code te pedirá iniciar sesión.',
    placeHolder: 'Trabajo',
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
  fs.mkdirSync(target.dir, { recursive: true });
  // A new account starts with the same model, effort and permissions as the first one.
  if (canCopySettings(primaryAccount(), target)) {
    copySettings(primaryAccount(), target);
    log.info(`${target.id}: settings.json copiado de ${primaryAccount().id}`);
  }
  await switchTo(target);
}

async function removeAccount(): Promise<void> {
  const removable = accounts.filter((a) => a !== primaryAccount() && a !== active);
  if (removable.length === 0) {
    void vscode.window.showInformationMessage('No hay cuentas que quitar: la primera y la que usa esta ventana se quedan.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    removable.map((a) => ({ label: a.label, description: readAccountInfo(a).email ?? '', detail: a.dir, account: a })),
    { title: 'Quitar una cuenta de la lista', placeHolder: 'Elige la cuenta que quieres quitar' },
  );
  if (!picked) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `¿Quitar la cuenta «${picked.account.label}» de la lista?`,
    { modal: true, detail: `No se borra nada: su carpeta (${picked.account.dir}) y su sesión siguen ahí. Si la vuelves a añadir con el mismo nombre, recupera todo.` },
    'Quitar',
  );
  if (choice === 'Quitar') {
    await config().update('accounts', configuredAccounts().filter((c) => c.id !== picked.account.id), vscode.ConfigurationTarget.Global);
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
      const choice = await vscode.window.showWarningMessage(
        `${pendingMerge.map((p) => p.link).join(', ')} ya tiene contenido.`,
        { modal: true, detail: `¿Lo muevo a ${primary.dir} y dejo un enlace, para que ambas cuentas compartan historial? Si un archivo ya existe en los dos, se conservan ambos.` },
        'Fusionar y enlazar',
        'Seguir sin enlazar',
      );
      if (choice === undefined) {
        return false;
      }
      if (choice === 'Fusionar y enlazar') {
        const merged = ensureSharedFolders(primary, account, pendingMerge.map((p) => p.name), true);
        statuses = statuses.map((s) => merged.find((m) => m.name === s.name) ?? s);
      }
    }
    for (const s of statuses) {
      const line = `${account.id}: ${s.link} → ${s.target}: ${s.state}`;
      if (s.state === 'foreign-link' || s.state === 'not-a-dir') {
        log.warn(line);
        if (interactive) {
          void vscode.window.showWarningMessage(`${s.link} no apunta a ${s.target}; no lo toqué.`);
        }
      } else {
        log.info(line);
      }
    }
    if (alignCleanupPeriod(primary, account)) {
      log.info(`${account.id}: cleanupPeriodDays igualado al de ${primary.id} (el historial es compartido)`);
    }
  } catch (e) {
    log.error(`no se pudo preparar el perfil ${account.id}: ${e}`);
    if (interactive) {
      void vscode.window.showErrorMessage(`No se pudo preparar el perfil ${account.label}: ${e instanceof Error ? e.message : e}`);
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
  return {
    account: active.id,
    days: quotaDays(samples, week, resetsAt),
    budget: dailyBudget(samples, week, resetsAt),
    used7d: usedSince(samples, Date.now() - 7 * 86_400_000),
    recordedSince: samples[0]?.t,
  };
}

function showUsage(): void {
  UsagePanel.show(ctx.extensionUri, async (): Promise<PanelData> => {
    refreshUsage();
    const scan = await scanTranscripts(accounts, SCAN_DAYS);
    log.info(`consumo: ${scan.files} archivos, ${scan.records.length} grupos, ${scan.ms} ms`);
    return {
      generatedAt: Date.now(),
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

// ---------- diagnostics ----------

function diagnostics(): void {
  const official = vscode.extensions.getExtension(OFFICIAL_ID);
  const lines = [
    '--- diagnóstico ---',
    `switcher ${ctx.extension.packageJSON.version} en ${kindName(ctx.extension.extensionKind)} (pid ${process.pid})`,
    `cuenta de esta ventana: ${active.id}${stale ? ' (falta reiniciar las extensiones para aplicar un cambio de configuración)' : ''}`,
    `cuenta que tomó Claude Code (según su lock en <perfil>/ide): ${officialAccount()?.id ?? 'sin confirmar'}`,
    `CLAUDE_CONFIG_DIR ahora: ${process.env.CLAUDE_CONFIG_DIR ?? 'sin definir'} · al arrancar: ${baseConfigDirEnv() ?? 'sin definir'}`,
    official ? `Claude Code ${official.packageJSON.version} en ${kindName(official.extensionKind)}, activa=${official.isActive}` : 'Claude Code: no encontrada en este host',
    `uso de ${active.id}: ${sourceText(activeUsage)}`,
    `respuestas en curso en esta ventana: ${workingSessions(active, folders()).length}`,
  ];
  const primary = primaryAccount();
  for (const a of accounts) {
    const info = readAccountInfo(a);
    lines.push(`${a.id}: ${a.dir} · CLAUDE_CONFIG_DIR=${a.envValue ?? 'sin definir'} · sesión=${info.loggedIn ? info.email ?? 'sí' : 'no'}`);
    if (a !== primary) {
      for (const name of config().get<string[]>('sharedFolders', ['projects'])) {
        const s = linkStatus(primary, a, name);
        lines.push(`   ${name}: ${s.state} (${s.link} → ${s.target})`);
      }
    }
  }
  for (const p of problems()) {
    lines.push(`PROBLEMA: ${p}`);
  }
  for (const line of lines) {
    log.info(line);
  }
  log.show(true);
}
