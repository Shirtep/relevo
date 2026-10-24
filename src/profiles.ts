import * as fs from 'fs';
import * as path from 'path';
import { Account, samePath } from './accounts';

export type LinkState = 'linked' | 'missing' | 'empty-dir' | 'non-empty-dir' | 'foreign-link' | 'not-a-dir';

export interface LinkStatus {
  name: string;
  /** Folder in the primary profile (the real one). */
  target: string;
  /** Folder in the secondary profile that should point at target. */
  link: string;
  state: LinkState;
}

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

export function sameRealDir(a: string, b: string): boolean {
  const ra = realpathOrUndefined(a);
  const rb = realpathOrUndefined(b);
  return ra !== undefined && rb !== undefined && samePath(ra, rb);
}

export function linkStatus(primary: Account, account: Account, name: string): LinkStatus {
  const target = path.join(primary.dir, name);
  const link = path.join(account.dir, name);
  let state: LinkState;
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(link);
  } catch {
    st = undefined;
  }
  if (!st) {
    state = 'missing';
  } else if (st.isSymbolicLink()) {
    state = sameRealDir(link, target) ? 'linked' : 'foreign-link';
  } else if (!st.isDirectory()) {
    state = 'not-a-dir';
  } else {
    state = fs.readdirSync(link).length === 0 ? 'empty-dir' : 'non-empty-dir';
  }
  return { name, target, link, state };
}

/** Moves everything in `from` into `to`; a name clash keeps both, renaming the moved one. */
export function mergeInto(from: string, to: string, tag: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    } else if (entry.isDirectory() && fs.statSync(dst).isDirectory()) {
      mergeInto(src, dst, tag);
      fs.rmdirSync(src);
    } else {
      const ext = path.extname(entry.name);
      const stem = entry.name.slice(0, entry.name.length - ext.length);
      fs.renameSync(src, path.join(to, `${stem}.from-${tag}-${Date.now()}${ext}`));
    }
  }
}

/**
 * Makes `account`'s shared folders point at the primary's. Safe cases (missing or empty) are
 * fixed directly; a non-empty folder is only merged when `allowMerge` is true.
 */
export function ensureSharedFolders(
  primary: Account,
  account: Account,
  names: string[],
  allowMerge: boolean,
): LinkStatus[] {
  const result: LinkStatus[] = [];
  for (const name of names) {
    const status = linkStatus(primary, account, name);
    const { target, link } = status;
    switch (status.state) {
      case 'missing':
        fs.mkdirSync(target, { recursive: true });
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(target, link, LINK_TYPE);
        status.state = 'linked';
        break;
      case 'empty-dir':
        fs.mkdirSync(target, { recursive: true });
        fs.rmdirSync(link);
        fs.symlinkSync(target, link, LINK_TYPE);
        status.state = 'linked';
        break;
      case 'non-empty-dir':
        if (allowMerge) {
          mergeInto(link, target, account.id);
          fs.rmdirSync(link);
          fs.symlinkSync(target, link, LINK_TYPE);
          status.state = 'linked';
        }
        break;
    }
    result.push(status);
  }
  return result;
}

function readSettings(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function settingsPath(account: Account): string {
  return path.join(account.dir, 'settings.json');
}

export function canCopySettings(primary: Account, account: Account): boolean {
  return fs.existsSync(settingsPath(primary)) && !fs.existsSync(settingsPath(account));
}

export function copySettings(primary: Account, account: Account): void {
  fs.mkdirSync(account.dir, { recursive: true });
  fs.copyFileSync(settingsPath(primary), settingsPath(account));
}

/**
 * With a shared projects folder, each profile's CLI prunes old transcripts using its own
 * cleanupPeriodDays. Copy the primary's value so the other profile never deletes history
 * the primary was told to keep. Returns true when it changed something.
 */
export function alignCleanupPeriod(primary: Account, account: Account): boolean {
  const days = readSettings(settingsPath(primary))?.cleanupPeriodDays;
  if (days === undefined) {
    return false;
  }
  const file = settingsPath(account);
  const exists = fs.existsSync(file);
  const current = exists ? readSettings(file) : {};
  if (current === undefined || current.cleanupPeriodDays === days) {
    return false;
  }
  current.cleanupPeriodDays = days;
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  return true;
}
