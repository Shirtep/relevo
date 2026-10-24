import * as fs from 'fs';
import { Account } from './accounts';

/**
 * Everything here is read from files Claude Code itself writes in the profile folder. Relevo
 * never reads credentials or tokens and never contacts Anthropic: the usage figures are the ones
 * Claude Code last fetched and stored in its global config (.claude.json).
 */

export interface UsageWindow {
  /** Percent used, 0-100. */
  pct: number;
  /** Epoch ms when the window resets. */
  resetsAt?: number;
}

export interface AccountUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** 'cli-cache' = Claude Code's own figures from .claude.json. */
  source: 'cli-cache' | 'none';
  /** When Claude Code measured them (epoch ms); 0 when there are none. */
  fetchedAt: number;
}

export interface AccountInfo {
  email?: string;
  loggedIn: boolean;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function readAccountInfo(account: Account): AccountInfo {
  const oauthAccount = readJson(account.globalConfigPath)?.oauthAccount;
  return {
    email: typeof oauthAccount?.emailAddress === 'string' ? oauthAccount.emailAddress : undefined,
    // Only whether a credentials file exists: its contents are never opened.
    loggedIn: Boolean(oauthAccount) || fs.existsSync(account.credentialsPath),
  };
}

function parseWindow(raw: any): UsageWindow | undefined {
  if (!raw || typeof raw.utilization !== 'number') {
    return undefined;
  }
  const resetsAt = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : NaN;
  return { pct: raw.utilization, resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt };
}

/** Parses the utilization block Claude Code stores as cachedUsageUtilization.utilization. */
export function parseUtilization(raw: any): Pick<AccountUsage, 'fiveHour' | 'sevenDay'> {
  return { fiveHour: parseWindow(raw?.five_hour), sevenDay: parseWindow(raw?.seven_day) };
}

/** A window whose reset time has passed has been emptied, whatever the stale number says. */
export function effectivePct(w: UsageWindow | undefined, now = Date.now()): number | undefined {
  if (!w) {
    return undefined;
  }
  return w.resetsAt !== undefined && w.resetsAt <= now ? 0 : w.pct;
}

/** The usage Claude Code last recorded for this profile. */
export function readUsage(account: Account): AccountUsage {
  const config = readJson(account.globalConfigPath);
  const cached = config?.cachedUsageUtilization;
  if (!cached || typeof cached.fetchedAtMs !== 'number') {
    return { source: 'none', fetchedAt: 0 };
  }
  // After a re-login with another account the cache may still describe the old one.
  const owner = config?.oauthAccount?.accountUuid;
  if (owner && cached.accountUuid && owner !== cached.accountUuid) {
    return { source: 'none', fetchedAt: 0 };
  }
  return { ...parseUtilization(cached.utilization), source: 'cli-cache', fetchedAt: cached.fetchedAtMs };
}
