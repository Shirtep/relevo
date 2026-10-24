import * as fs from 'fs';
import * as path from 'path';
import { Account } from './accounts';

export interface WorkingSession {
  pid: number;
  status: string;
  cwd: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Claude Code sessions of this window that restarting the extension host would cut short: each
 * CLI process writes <profile>/sessions/<pid>.json with its status ("idle", "busy" mid-turn, or
 * "waiting" on the user). Only ones the editor launched count; a `claude` typed in a terminal
 * survives the restart. Files left by a crashed process are skipped by checking the pid.
 */
export function workingSessions(account: Account, folders: string[], alive: (pid: number) => boolean = isAlive): WorkingSession[] {
  const dir = path.join(account.dir, 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const found: WorkingSession[] = [];
  for (const name of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (
        s?.entrypoint === 'claude-vscode' &&
        (s.status === 'busy' || s.status === 'waiting') &&
        typeof s.pid === 'number' &&
        typeof s.cwd === 'string' &&
        folders.some((f) => isInside(s.cwd, f)) &&
        alive(s.pid)
      ) {
        found.push({ pid: s.pid, status: s.status, cwd: s.cwd });
      }
    } catch {
      // being rewritten or removed
    }
  }
  return found;
}
