import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { t } from './i18n';

export interface AccountConfig {
  id: string;
  label?: string;
  configDir?: string;
}

export interface Account {
  id: string;
  label: string;
  /** Absolute profile folder (where credentials, sessions and projects live). */
  dir: string;
  /** Value for CLAUDE_CONFIG_DIR, or undefined to leave it unset (default profile). */
  envValue: string | undefined;
  /** The CLI's global config file: ~/.claude.json, or <dir>/.claude.json when CLAUDE_CONFIG_DIR is set. */
  globalConfigPath: string;
  credentialsPath: string;
}

/** The default profile, where whoever already uses Claude Code is signed in. */
export const PRIMARY_ACCOUNT: AccountConfig = { id: 'A', configDir: '' };

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Profiles that already exist as ~/.claude-<name> folders with a Claude Code sign-in in them, for
 * people who were switching accounts by hand with CLAUDE_CONFIG_DIR before installing.
 */
export function discoverProfiles(home = os.homedir()): AccountConfig[] {
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  const found: AccountConfig[] = [];
  for (const name of names.sort()) {
    const m = /^\.claude-(.+)$/.exec(name);
    const dir = path.join(home, name);
    if (!m || !slugify(m[1])) {
      continue;
    }
    try {
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    if (readJson(path.join(dir, '.claude.json'))?.oauthAccount || fs.existsSync(path.join(dir, '.credentials.json'))) {
      found.push({ id: m[1], configDir: `~/${name}` });
    }
  }
  return found;
}

/** The account list before the user saves one: the default profile plus any existing ones. */
export function defaultAccountConfigs(home = os.homedir()): AccountConfig[] {
  return [PRIMARY_ACCOUNT, ...discoverProfiles(home)];
}

/** "maria.perez@example.com" → "maria.perez", the name shown for an account without a label. */
function emailName(globalConfigPath: string): string | undefined {
  const email = readJson(globalConfigPath)?.oauthAccount?.emailAddress;
  return typeof email === 'string' && email.includes('@') ? email.split('@')[0] : undefined;
}

export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The settings entry for a new account called `name` (profile folder ~/.claude-<name>), or why it can't be. */
export function newAccountConfig(existing: AccountConfig[], name: string): { config: AccountConfig } | { error: string } {
  const label = name.trim();
  if (label === '') {
    return { error: t('Type a name.') };
  }
  const taken = (s: string) => existing.some((c) => [c.id, c.label ?? ''].some((v) => v.trim().toLowerCase() === s.toLowerCase()));
  if (taken(label)) {
    return { error: t('An account with that name already exists.') };
  }
  const slug = slugify(label);
  if (slug === '') {
    return { error: t('Use at least one letter or number.') };
  }
  const used = new Set(existing.map((c) => (c.configDir ?? '').trim().toLowerCase()));
  let suffix = slug;
  for (let n = 2; used.has(`~/.claude-${suffix}`) || taken(suffix); n++) {
    suffix = `${slug}-${n}`;
  }
  return { config: { id: suffix, label, configDir: `~/.claude-${suffix}` } };
}

const BASE_KEY = Symbol.for('relevo.baseConfigDir');

/**
 * CLAUDE_CONFIG_DIR as the extension host received it, before we touched it.
 * Kept on globalThis so a re-activation in the same process doesn't capture our own value.
 */
export function baseConfigDirEnv(): string | undefined {
  const g = globalThis as Record<symbol, string | undefined>;
  if (!(BASE_KEY in g)) {
    g[BASE_KEY] = process.env.CLAUDE_CONFIG_DIR || undefined;
  }
  return g[BASE_KEY];
}

export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') {
    return home;
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

export function resolveAccounts(
  configs: AccountConfig[] | undefined,
  base = baseConfigDirEnv(),
  home = os.homedir(),
): Account[] {
  const valid = (configs ?? []).filter((c) => c && typeof c.id === 'string' && c.id.trim() !== '');
  const list = valid.length > 0 ? valid : defaultAccountConfigs(home);
  const seen = new Set<string>();
  const accounts: Account[] = [];
  for (const c of list) {
    const id = c.id.trim();
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const raw = (c.configDir ?? '').trim();
    let dir: string;
    let envValue: string | undefined;
    if (raw === '') {
      envValue = base;
      dir = base ? path.resolve(base) : path.join(home, '.claude');
    } else {
      dir = path.resolve(expandHome(raw, home));
      envValue = dir;
    }
    const globalConfigPath = envValue ? path.join(envValue, '.claude.json') : path.join(home, '.claude.json');
    accounts.push({
      id,
      label: c.label?.trim() || emailName(globalConfigPath) || id,
      dir,
      envValue,
      globalConfigPath,
      credentialsPath: path.join(dir, '.credentials.json'),
    });
  }
  return accounts;
}

export function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
