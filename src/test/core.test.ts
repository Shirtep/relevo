import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { discoverProfiles, newAccountConfig, resolveAccounts, slugify } from '../accounts';
import { alignCleanupPeriod, ensureSharedFolders, linkStatus } from '../profiles';
import { workingSessions } from '../sessions';
import { UsageHistory, dailyBudget, quotaDays, usedSince } from '../history';
import { costOf } from '../pricing';
import { scanTranscripts, UNKNOWN_ACCOUNT } from '../transcripts';
import { effectivePct, parseUtilization, readAccountInfo, readUsage } from '../usage';

// The suite may run inside a window that already points at another profile; start from none.
delete process.env.CLAUDE_CONFIG_DIR;

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cas-test-'));
}

function profiles(home: string) {
  return resolveAccounts(
    [
      { id: 'A', configDir: '' },
      { id: 'B', configDir: '~/.claude-b' },
    ],
    undefined,
    home,
  );
}

test('default account leaves CLAUDE_CONFIG_DIR unset and keeps ~/.claude.json', () => {
  const home = tempHome();
  const [a, b] = profiles(home);
  assert.equal(a.envValue, undefined);
  assert.equal(a.dir, path.join(home, '.claude'));
  assert.equal(a.globalConfigPath, path.join(home, '.claude.json'));
  assert.equal(b.envValue, path.join(home, '.claude-b'));
  assert.equal(b.globalConfigPath, path.join(home, '.claude-b', '.claude.json'));
});

test('default account follows a CLAUDE_CONFIG_DIR the host already had', () => {
  const home = tempHome();
  const base = path.join(home, 'custom');
  const [a] = resolveAccounts([{ id: 'A' }], base, home);
  assert.equal(a.envValue, base);
  assert.equal(a.globalConfigPath, path.join(base, '.claude.json'));
});

test('shared folders: missing and empty folders become links, content needs consent', () => {
  const home = tempHome();
  const [a, b] = profiles(home);
  fs.mkdirSync(path.join(a.dir, 'projects', 'p1'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'projects', 'p1', 's1.jsonl'), 'a');

  const [linked] = ensureSharedFolders(a, b, ['projects'], false);
  assert.equal(linked.state, 'linked');
  assert.ok(fs.existsSync(path.join(b.dir, 'projects', 'p1', 's1.jsonl')));

  fs.mkdirSync(path.join(b.dir, 'skills'), { recursive: true });
  assert.equal(ensureSharedFolders(a, b, ['skills'], false)[0].state, 'linked');

  fs.mkdirSync(path.join(b.dir, 'agents', 'x'), { recursive: true });
  fs.writeFileSync(path.join(b.dir, 'agents', 'x', 'one.md'), 'b');
  fs.mkdirSync(path.join(a.dir, 'agents', 'x'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'agents', 'x', 'one.md'), 'a');
  assert.equal(ensureSharedFolders(a, b, ['agents'], false)[0].state, 'non-empty-dir');
  assert.equal(ensureSharedFolders(a, b, ['agents'], true)[0].state, 'linked');
  const merged = fs.readdirSync(path.join(a.dir, 'agents', 'x')).sort();
  assert.equal(merged.length, 2, 'both copies of a clashing file are kept');
  assert.equal(fs.readFileSync(path.join(a.dir, 'agents', 'x', 'one.md'), 'utf8'), 'a');
  assert.equal(linkStatus(a, b, 'agents').state, 'linked');
});

test('cleanupPeriodDays is copied so a shared history is pruned by one rule', () => {
  const home = tempHome();
  const [a, b] = profiles(home);
  fs.mkdirSync(a.dir, { recursive: true });
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }));
  fs.writeFileSync(path.join(b.dir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  assert.equal(alignCleanupPeriod(a, b), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.dir, 'settings.json'), 'utf8')), { model: 'opus', cleanupPeriodDays: 365 });
  assert.equal(alignCleanupPeriod(a, b), false);
});

function assistantLine(sessionId: string, cwd: string, ts: number, id: string, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    cwd,
    requestId: `req_${id}`,
    timestamp: new Date(ts).toISOString(),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: output, cache_creation_input_tokens: 10, cache_read_input_tokens: 100 } },
  });
}

test('transcripts: dedupe per response and attribute sessions to profiles', async () => {
  const home = tempHome();
  const [a, b] = profiles(home);
  const now = Date.now();
  const proj = path.join(a.dir, 'projects', '-w-one');
  fs.mkdirSync(proj, { recursive: true });
  ensureSharedFolders(a, b, ['projects'], false);

  // sA ran only in A; sB only in B; sR started in A and was resumed in B; sX has no session-env.
  fs.mkdirSync(path.join(a.dir, 'session-env', 'sA'), { recursive: true });
  fs.mkdirSync(path.join(b.dir, 'session-env', 'sB'), { recursive: true });
  fs.mkdirSync(path.join(a.dir, 'session-env', 'sR'), { recursive: true });
  await new Promise((r) => setTimeout(r, 20));
  fs.mkdirSync(path.join(b.dir, 'session-env', 'sR'), { recursive: true });

  const lines = [
    assistantLine('sA', '/w/one/sub', now - 3_600_000, 'm1', 5), // agent cd-ed into a subfolder
    assistantLine('sA', '/w/one', now - 3_600_000, 'm1', 7), // same response, later block
    assistantLine('sB', '/w/one', now - 3_600_000, 'm2', 11),
    assistantLine('sR', '/w/one', now - 3_600_000, 'm3', 13), // before the resume → A
    assistantLine('sR', '/w/one', now - 30_000, 'm4', 17), // after the resume → B
    assistantLine('sX', '/w/one', now - 3_600_000, 'm5', 19),
    assistantLine('sA', '/w/one', now - 10 * 86_400_000, 'old', 1000), // outside the window
    '{"type":"user","message":{"content":"hola"}}',
    'not json',
  ];
  fs.writeFileSync(path.join(proj, 'one.jsonl'), lines.join('\n'));

  const scan = await scanTranscripts([a, b], 8, now);
  const output = (account: string) => scan.records.filter((r) => r.account === account).reduce((s, r) => s + r.output, 0);
  assert.equal(output('A'), 7 + 13);
  assert.equal(output('B'), 11 + 17);
  assert.equal(output(UNKNOWN_ACCOUNT), 19);
  assert.equal(scan.records.reduce((s, r) => s + r.messages, 0), 5);
  assert.deepEqual([...new Set(scan.records.map((r) => r.project))], ['/w/one'], 'subfolder cwd counts toward the project');
});

test('transcripts: separate projects folders are attributed by folder', async () => {
  const home = tempHome();
  const [a, b] = profiles(home);
  const now = Date.now();
  for (const [acc, out] of [[a, 3], [b, 4]] as const) {
    const dir = path.join(acc.dir, 'projects', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), assistantLine('s', '/w', now - 60_000, `m-${acc.id}`, out));
  }
  const scan = await scanTranscripts([a, b], 8, now);
  assert.deepEqual(scan.records.map((r) => [r.account, r.output]).sort(), [['A', 3], ['B', 4]]);
});

test('usage parsing and expired windows', () => {
  const parsed = parseUtilization({ five_hour: { utilization: 11, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 53, resets_at: null } });
  assert.deepEqual(parsed.fiveHour, { pct: 11, resetsAt: Date.parse('2030-01-01T00:00:00Z') });
  assert.equal(parsed.sevenDay?.pct, 53);
  assert.equal(effectivePct({ pct: 80, resetsAt: Date.now() - 1 }), 0);
  assert.equal(effectivePct({ pct: 80, resetsAt: Date.now() + 60_000 }), 80);
});

test('usage comes only from what Claude Code stored; credentials are never opened', () => {
  const home = tempHome();
  const [a] = profiles(home);
  fs.mkdirSync(a.dir, { recursive: true });
  assert.deepEqual(readUsage(a), { source: 'none', fetchedAt: 0 });
  assert.deepEqual(readAccountInfo(a), { email: undefined, loggedIn: false });

  // A credentials file only counts by existing: an unreadable one proves its contents are not needed.
  fs.mkdirSync(a.credentialsPath);
  assert.equal(readAccountInfo(a).loggedIn, true);

  const fetchedAtMs = Date.now() - 60_000;
  const cache = { fetchedAtMs, accountUuid: 'u1', utilization: { five_hour: { utilization: 40 }, seven_day: { utilization: 20, resets_at: '2030-01-01T00:00:00Z' } } };
  fs.writeFileSync(a.globalConfigPath, JSON.stringify({ oauthAccount: { accountUuid: 'u1', emailAddress: 'a@example.com' }, cachedUsageUtilization: cache }));
  const u = readUsage(a);
  assert.equal(u.source, 'cli-cache');
  assert.equal(u.fetchedAt, fetchedAtMs);
  assert.equal(u.fiveHour?.pct, 40);
  assert.equal(u.sevenDay?.resetsAt, Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(readAccountInfo(a).email, 'a@example.com');

  // After signing in with another account, the old account's figures are not shown.
  fs.writeFileSync(a.globalConfigPath, JSON.stringify({ oauthAccount: { accountUuid: 'u2' }, cachedUsageUtilization: cache }));
  assert.equal(readUsage(a).source, 'none');
});

test('new accounts get a readable, unique profile folder', () => {
  assert.equal(slugify('  Trabajo Ñandú! '), 'trabajo-nandu');
  const existing = [{ id: 'A', configDir: '' }, { id: 'B', configDir: '~/.claude-b' }];
  assert.deepEqual(newAccountConfig(existing, ' Trabajo '), { config: { id: 'trabajo', label: 'Trabajo', configDir: '~/.claude-trabajo' } });
  assert.deepEqual(newAccountConfig(existing, 'b'), { error: 'Ya hay una cuenta con ese nombre.' });
  assert.ok('error' in newAccountConfig(existing, '   '));
  assert.ok('error' in newAccountConfig(existing, '***'));
  // "Mi cuenta" and "mi-cuenta" are different names but would share a folder: the second gets a suffix.
  const taken = [...existing, { id: 'mi-cuenta', label: 'Mi cuenta', configDir: '~/.claude-mi-cuenta' }];
  assert.deepEqual(newAccountConfig(taken, 'Mi  cuenta!'), { config: { id: 'mi-cuenta-2', label: 'Mi  cuenta!', configDir: '~/.claude-mi-cuenta-2' } });
  assert.ok('error' in newAccountConfig(taken, 'mi cuenta'), 'labels are unique ignoring case');
});

test('sessions: only editor-launched sessions of this window that are working block a switch', () => {
  const home = tempHome();
  const [a] = profiles(home);
  const dir = path.join(a.dir, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const write = (pid: number, over: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, status: 'busy', entrypoint: 'claude-vscode', cwd: path.join(home, 'proj'), ...over }));
  write(1, {}); // working here
  write(2, { status: 'idle' });
  write(3, { status: 'waiting' }); // waiting on the user is cut short too
  write(4, { cwd: path.join(home, 'other') }); // another window's project
  write(5, { entrypoint: 'cli' }); // a terminal `claude` survives the restart
  write(6, { cwd: path.join(home, 'proj', 'sub') }); // subfolder of the workspace
  write(7, {}); // crashed: pid no longer alive
  fs.writeFileSync(path.join(dir, '8.json'), '{not json');
  fs.writeFileSync(path.join(dir, '9.key'), 'x');
  const found = workingSessions(a, [path.join(home, 'proj')], (pid) => pid !== 7);
  assert.deepEqual(found.map((s) => s.pid).sort(), [1, 3, 6]);
  assert.deepEqual(workingSessions(a, [], () => true), [], 'a window without folders blocks nothing');
  assert.deepEqual(workingSessions({ ...a, dir: path.join(home, 'missing') }, [home]), []);
});

const H = 3_600_000;
const D = 24 * H;

test('daily budget: spending 25% on the first day shrinks the rest; a skipped day grows it', () => {
  const resetsAt = Date.UTC(2026, 9, 26, 6, 0);
  // Window started 7 days before the reset. Day 1 used 25%.
  const day1 = resetsAt - 7 * D;
  const samples = [
    { t: day1 + H, week: 0, weekResetsAt: resetsAt },
    { t: day1 + 10 * H, week: 25, weekResetsAt: resetsAt },
  ];
  // Start of day 2: 75% left for 6 days.
  let b = dailyBudget(samples, 25, resetsAt, day1 + D + H);
  assert.equal(b.daysLeft, 6);
  assert.equal(b.startPct, 25);
  assert.equal(b.allowance, 12.5);
  assert.equal(b.usedToday, 0);
  // Day 2 skipped entirely; on day 3 the same 75% is split across 5 days.
  b = dailyBudget(samples, 25, resetsAt, day1 + 2 * D + H);
  assert.equal(b.allowance, 15);
  // Day 3: 6% used so far today.
  const later = [...samples, { t: day1 + 2 * D + 3 * H, week: 31, weekResetsAt: resetsAt }];
  b = dailyBudget(later, 31, resetsAt, day1 + 2 * D + 4 * H);
  assert.equal(b.startPct, 25);
  assert.equal(b.usedToday, 6);
  assert.equal(b.leftToday, 9);
  assert.equal(b.partial, false);
});

test('quota days follow the reset time and survive a weekly reset between samples', () => {
  const resetsAt = Date.UTC(2026, 9, 26, 6, 0);
  const prevReset = resetsAt - 7 * D;
  const samples = [
    { t: prevReset - 2 * H, week: 90, weekResetsAt: prevReset }, // end of the previous week
    { t: prevReset + 2 * H, week: 4, weekResetsAt: resetsAt }, // after the reset: 4% is new use
    { t: prevReset + D + 5 * H, week: 10, weekResetsAt: resetsAt },
  ];
  const days = quotaDays(samples, 10, resetsAt, prevReset + D + 6 * H);
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.state), ['past', 'today', 'future', 'future', 'future', 'future', 'future']);
  assert.equal(days[0].used, 4);
  assert.equal(days[1].used, 6);
  assert.equal(days[0].start, prevReset);
  assert.equal(days[2].allowance, (100 - 4) / 6);
  assert.equal(usedSince(samples, prevReset - D, prevReset + D + 6 * H), 10);
});

test('history keeps changes and thins out repeats', () => {
  const home = tempHome();
  const h = new UsageHistory(home);
  const now = Date.now();
  const usage = (t: number, week: number) => ({ source: 'cli-cache' as const, fetchedAt: t, sevenDay: { pct: week, resetsAt: now + 3 * D } });
  h.record('k', usage(now - 50 * 60_000, 10));
  h.record('k', usage(now - 45 * 60_000, 10)); // same value 5 min later: skipped
  h.record('k', usage(now - 40 * 60_000, 12));
  h.record('k', usage(now - 40 * 60_000, 12)); // same timestamp: skipped
  h.record('k', usage(now - 5 * 60_000, 12)); // same value but 35 min later: kept
  assert.deepEqual(h.samples('k').map((s) => s.week), [10, 12, 12]);
  h.record('k', { source: 'none', fetchedAt: 0 });
  assert.equal(h.samples('k').length, 3);
});

test('relative cost weighs models and cache like the API price list', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(costOf('claude-opus-5-5', usage), 5);
  assert.equal(costOf('claude-sonnet-5-5', usage), 3);
  assert.equal(costOf('claude-haiku-5-5', usage), 1);
  assert.equal(costOf('claude-opus-4-1', usage), 15);
  assert.equal(costOf('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }), 0.5);
  assert.equal(costOf('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }), 10);
  assert.equal(costOf('claude-opus-5-5', { output_tokens: 1_000_000 }), 25);
});

test('an existing install is recognized: the signed-in default profile and hand-made profiles', () => {
  const home = tempHome();
  // Someone already using Claude Code: signed in on the default profile.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'maria.perez@example.com' } }));
  let accounts = resolveAccounts(undefined, undefined, home);
  assert.deepEqual(accounts.map((a) => [a.id, a.label]), [['A', 'maria.perez']]);

  // Profiles they had set up by hand with CLAUDE_CONFIG_DIR are picked up too; empty or unrelated folders are not.
  fs.mkdirSync(path.join(home, '.claude-trabajo'));
  fs.writeFileSync(path.join(home, '.claude-trabajo', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'mp@empresa.com' } }));
  fs.mkdirSync(path.join(home, '.claude-otra'));
  fs.writeFileSync(path.join(home, '.claude-otra', '.credentials.json'), '{}');
  fs.mkdirSync(path.join(home, '.claude-vacia'));
  fs.writeFileSync(path.join(home, '.claude-nota'), 'not a folder');
  assert.deepEqual(discoverProfiles(home).map((c) => c.configDir), ['~/.claude-otra', '~/.claude-trabajo']);
  accounts = resolveAccounts(undefined, undefined, home);
  assert.deepEqual(accounts.map((a) => [a.id, a.label]), [['A', 'maria.perez'], ['otra', 'otra'], ['trabajo', 'mp']]);

  // A saved list wins over discovery, and an explicit label over the email.
  accounts = resolveAccounts([{ id: 'A', label: 'Personal', configDir: '' }], undefined, home);
  assert.deepEqual(accounts.map((a) => [a.id, a.label]), [['A', 'Personal']]);
});
