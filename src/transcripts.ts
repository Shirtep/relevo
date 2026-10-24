import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Account, samePath } from './accounts';
import { costOf } from './pricing';

export const UNKNOWN_ACCOUNT = '?';

/** Token totals for one (hour, project, account, model, effort) bucket. */
export interface UsageRecord {
  /** Start of the UTC hour, epoch ms. */
  hour: number;
  project: string;
  account: string;
  model: string;
  /** Effort level the response was asked for ("low" … "xhigh"), or "" when the transcript doesn't say. */
  effort: string;
  /** Relative weight in API-price dollars (see pricing.ts); only meaningful as a share. */
  cost: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  messages: number;
}

export interface ScanResult {
  records: UsageRecord[];
  files: number;
  ms: number;
}

/**
 * A resumed session gets a session-env/<id> folder in every profile that ran it. Before this
 * lead time ahead of that folder's creation a message still belongs to the earlier profile.
 */
const SWITCH_LEAD_MS = 2 * 60_000;

interface Owner {
  account: string;
  since: number;
}

interface Group {
  root: string;
  accounts: Account[];
}

function realpathOr(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** Accounts that share one physical projects folder end up in the same group. */
function groupByProjectsRoot(accounts: Account[]): Group[] {
  const groups: Group[] = [];
  for (const account of accounts) {
    const root = realpathOr(path.join(account.dir, 'projects'));
    if (!root) {
      continue;
    }
    const group = groups.find((g) => samePath(g.root, root));
    if (group) {
      group.accounts.push(account);
    } else {
      groups.push({ root, accounts: [account] });
    }
  }
  return groups;
}

function birthMs(p: string): number | undefined {
  try {
    const st = fs.statSync(p);
    return st.birthtimeMs > 0 ? st.birthtimeMs : Math.min(st.mtimeMs, st.ctimeMs);
  } catch {
    return undefined;
  }
}

class Attributor {
  private readonly owners = new Map<string, Owner[]>();

  constructor(private readonly group: Group) {}

  accountFor(sessionId: string, ts: number): string {
    if (this.group.accounts.length === 1) {
      return this.group.accounts[0].id;
    }
    let owners = this.owners.get(sessionId);
    if (!owners) {
      owners = [];
      for (const account of this.group.accounts) {
        const since = birthMs(path.join(account.dir, 'session-env', sessionId));
        if (since !== undefined) {
          owners.push({ account: account.id, since });
        }
      }
      owners.sort((a, b) => a.since - b.since);
      this.owners.set(sessionId, owners);
    }
    if (owners.length === 0) {
      return UNKNOWN_ACCOUNT;
    }
    let match = owners[0];
    for (const owner of owners) {
      if (owner.since - SWITCH_LEAD_MS <= ts) {
        match = owner;
      }
    }
    return match.account;
  }
}

function listJsonl(dir: string, since: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsonl(p, since, out);
    } else if (entry.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtimeMs >= since) {
          out.push(p);
        }
      } catch {
        // deleted while scanning
      }
    }
  }
}

function normalizeProject(cwd: string): string {
  // The same Windows folder shows up as both c:\ and C:\.
  return /^[a-zA-Z]:/.test(cwd) ? cwd[0].toLowerCase() + cwd.slice(1) : cwd;
}

/** How the CLI names a project's folder under projects/. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

interface Message {
  ts: number;
  sessionId: string;
  model: string;
  effort: string;
  usage: any;
}

interface FileMessages {
  messages: Map<string, Message>;
  /**
   * The session's project path. Lines carry the agent's cwd at that moment, which wanders into
   * subfolders, so prefer the cwd the projects/<dir> name was derived from.
   */
  project: string;
}

async function readMessages(file: string, since: number, projectDir: string): Promise<FileMessages> {
  const messages = new Map<string, Message>();
  const fallbackSession = path.basename(file, '.jsonl');
  let firstCwd: string | undefined;
  let projectCwd: string | undefined;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    // Most lines are tool output or user turns; skip them without paying for JSON.parse.
    if (!line.includes('"usage"') || !line.includes('"assistant"')) {
      continue;
    }
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (entry?.type !== 'assistant' || !usage || entry.message.model === '<synthetic>') {
      continue;
    }
    if (typeof entry.cwd === 'string' && entry.cwd && !projectCwd) {
      firstCwd ??= entry.cwd;
      if (encodeProjectDir(entry.cwd) === projectDir) {
        projectCwd = entry.cwd;
      }
    }
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts) || ts < since) {
      continue;
    }
    // Each content block of one API response is its own line carrying the same usage:
    // keep one per response, the last one written.
    const key = `${entry.message.id ?? ''}:${entry.requestId ?? ''}`;
    messages.set(key === ':' ? `${ts}:${messages.size}` : key, {
      ts,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : fallbackSession,
      model: typeof entry.message.model === 'string' ? entry.message.model : 'desconocido',
      effort: typeof entry.effort === 'string' ? entry.effort : '',
      usage,
    });
  }
  const project = projectCwd ?? firstCwd;
  return { messages, project: project ? normalizeProject(project) : projectDir };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Aggregates token usage from every profile's transcripts written in the last `days` days. */
export async function scanTranscripts(accounts: Account[], days: number, now = Date.now()): Promise<ScanResult> {
  const started = Date.now();
  const since = now - days * 86_400_000;
  const buckets = new Map<string, UsageRecord>();
  const seen = new Set<string>();
  let fileCount = 0;

  for (const group of groupByProjectsRoot(accounts)) {
    const attributor = new Attributor(group);
    /** projects/<dir> → display path; the first file that names it wins so a folder stays one row. */
    const projects = new Map<string, string>();
    const files: string[] = [];
    listJsonl(group.root, since, files);
    fileCount += files.length;
    for (const file of files) {
      const projectDir = path.relative(group.root, file).split(path.sep)[0];
      let parsed: FileMessages;
      try {
        parsed = await readMessages(file, since, projectDir);
      } catch {
        continue;
      }
      const project = projects.get(projectDir) ?? parsed.project;
      projects.set(projectDir, project);
      for (const [id, m] of parsed.messages) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        const account = attributor.accountFor(m.sessionId, m.ts);
        const hour = Math.floor(m.ts / 3_600_000) * 3_600_000;
        const key = [hour, project, account, m.model, m.effort].join('\u0000');
        let rec = buckets.get(key);
        if (!rec) {
          rec = { hour, project, account, model: m.model, effort: m.effort, cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
          buckets.set(key, rec);
        }
        rec.input += num(m.usage.input_tokens);
        rec.output += num(m.usage.output_tokens);
        rec.cacheWrite += num(m.usage.cache_creation_input_tokens);
        rec.cacheRead += num(m.usage.cache_read_input_tokens);
        rec.cost += costOf(m.model, m.usage);
        rec.messages += 1;
      }
    }
  }
  return { records: [...buckets.values()], files: fileCount, ms: Date.now() - started };
}
