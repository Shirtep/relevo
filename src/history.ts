import * as fs from 'fs';
import * as path from 'path';
import { AccountUsage, effectivePct } from './usage';

const DAY = 86_400_000;
const KEEP_MS = 15 * DAY;
/** A sample with the same numbers as the previous one is only kept after this long. */
const SAME_VALUE_GAP_MS = 30 * 60_000;
/** Two reset times further apart than this mean the weekly window rolled over between samples. */
const NEW_WINDOW_MS = 60 * 60_000;

/** The account's weekly utilization at one moment, as the API reported it. */
export interface Sample {
  t: number;
  week: number;
  weekResetsAt?: number;
}

/**
 * One "quota day": the weekly window cut into 7 slices of 24 h that end at the reset time,
 * so the days follow the quota itself and not any machine's time zone.
 */
export interface QuotaDay {
  start: number;
  end: number;
  state: 'past' | 'today' | 'future';
  /** Weekly % used in this day; undefined for future days or when nothing was recorded. */
  used?: number;
  /** For today and future days: the share left for each remaining day. */
  allowance?: number;
  /** Recording started partway through this day, so `used` may be short. */
  partial: boolean;
}

export interface Budget {
  /** Quota days left until the weekly reset, today included. */
  daysLeft: number;
  /** Weekly % already used when today started. */
  startPct: number;
  /** What each remaining day may use to reach the reset with quota left: (100 - startPct) / daysLeft. */
  allowance: number;
  usedToday: number;
  /** allowance - usedToday; negative when today went over. */
  leftToday: number;
  todayEnds: number;
  resetsAt: number;
  /** Recording began after today started, so usedToday only counts from then. */
  partial: boolean;
}

/** Weekly % added at each sample, also across a reset (then everything after it is new use). */
function increments(samples: Sample[]): { t: number; inc: number }[] {
  const out: { t: number; inc: number }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const rolled = a.weekResetsAt !== undefined && b.weekResetsAt !== undefined && Math.abs(b.weekResetsAt - a.weekResetsAt) > NEW_WINDOW_MS;
    const inc = rolled ? b.week : Math.max(0, b.week - a.week);
    if (inc > 0) {
      out.push({ t: b.t, inc });
    }
  }
  return out;
}

function usedBetween(incs: { t: number; inc: number }[], from: number, to: number): number {
  return incs.filter((x) => x.t > from && x.t <= to).reduce((s, x) => s + x.inc, 0);
}

export function dailyBudget(samples: Sample[], weekPct: number, resetsAt: number, now = Date.now()): Budget {
  const daysLeft = Math.max(1, Math.ceil((resetsAt - now) / DAY));
  const todayEnds = resetsAt - (daysLeft - 1) * DAY;
  const todayStarts = todayEnds - DAY;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const usedToday = Math.min(weekPct, usedBetween(increments(sorted), todayStarts, now));
  const startPct = Math.max(0, weekPct - usedToday);
  const allowance = (100 - startPct) / daysLeft;
  return {
    daysLeft,
    startPct,
    allowance,
    usedToday,
    leftToday: allowance - usedToday,
    todayEnds,
    resetsAt,
    partial: sorted.length === 0 || sorted[0].t > todayStarts,
  };
}

/** The 7 quota days of the current weekly window, with what each used or may still use. */
export function quotaDays(samples: Sample[], weekPct: number, resetsAt: number, now = Date.now()): QuotaDay[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const incs = increments(sorted);
  const first = sorted[0]?.t ?? now;
  const budget = dailyBudget(sorted, weekPct, resetsAt, now);
  const days: QuotaDay[] = [];
  for (let i = 7; i >= 1; i--) {
    const start = resetsAt - i * DAY;
    const end = start + DAY;
    const state = end <= now ? 'past' : start <= now ? 'today' : 'future';
    const recorded = first < end;
    days.push({
      start,
      end,
      state,
      used: state === 'future' || !recorded ? undefined : state === 'today' ? budget.usedToday : usedBetween(incs, start, end),
      allowance: state === 'past' ? undefined : budget.allowance,
      partial: recorded && first > start && state !== 'future',
    });
  }
  return days;
}

/** % used in [from, now] according to the samples. */
export function usedSince(samples: Sample[], from: number, now = Date.now()): number {
  return usedBetween(increments([...samples].sort((a, b) => a.t - b.t)), from, now);
}

/**
 * Samples of each account's weekly %, kept for 15 days in the extension's global storage. The
 * API value covers the whole account (every machine and claude.ai), so the differences between
 * samples measure the account's real daily use wherever it happened.
 */
export class UsageHistory {
  private readonly file: string;

  constructor(storageDir: string) {
    this.file = path.join(storageDir, 'usage-history.json');
  }

  samples(key: string): Sample[] {
    return this.read()[key] ?? [];
  }

  record(key: string, usage: AccountUsage): void {
    const week = effectivePct(usage.sevenDay, usage.fetchedAt);
    if (usage.source === 'none' || week === undefined) {
      return;
    }
    const data = this.read();
    const list = (data[key] ?? []).filter((s) => s.t > Date.now() - KEEP_MS);
    const last = list[list.length - 1];
    const sample: Sample = { t: usage.fetchedAt, week, weekResetsAt: usage.sevenDay?.resetsAt };
    if (last && (sample.t <= last.t || (sample.week === last.week && sample.weekResetsAt === last.weekResetsAt && sample.t - last.t < SAME_VALUE_GAP_MS))) {
      return;
    }
    list.push(sample);
    data[key] = list;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch {
      // history is best effort
    }
  }

  private read(): Record<string, Sample[]> {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }
}
