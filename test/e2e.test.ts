import { describe, expect, test } from 'bun:test';

import type { Config, FileActivity, MergedRateLimits, StatuslineInput } from '../src/types';
import { gatherEntries, sessionOrigin } from '../src/transcripts';
import { computeRatesBySession } from '../src/rate';
import { buildSnapshot } from '../src/shared';
import { buildStatusline } from '../src/buildStatusline';
import { quotaRgb, renderBar, truecolor } from '../src/format';

// ──────────────────────────────────────────────────────────────────────────
// Deterministic e2e against on-disk fixtures.
//
// NOW = 1_780_228_920_000 ms = 2026-05-31T12:02:00.000Z.
// windowSec = 120 → windowMs = 120_000 → winStart = NOW - 120s = 2026-05-31T12:00:00Z.
// Window is [12:00:00Z, 12:02:00Z] inclusive (end = max(now, maxTs) = now; no future ts).
// (Fixture files' real mtimes are after NOW, so they always pass the lookback filter.)
//
// Fixtures under test/fixtures/projects/. Per message:
//   enc-cur/sessCUR.jsonl                       (session "sessCUR", main transcript)
//     · msg_out_of_window  @ 11:59:00Z  in 50000 + out 50000 → BEFORE winStart → EXCLUDED
//     · msg_cur_A          @ 12:01:00Z  in 2000 + out 1000 + cw 1000 + cr 8000  (×3 dup rows)
//   enc-cur/sessCUR/subagents/agent-x.jsonl     (session "sessCUR", subagent)
//     · msg_cur_C_subagent @ 12:00:30Z  in 2000 + out 1000 + cw 1000 + cr 8000
//   enc-other/sessOTHER.jsonl                   (session "sessOTHER")
//     · msg_other_D        @ 12:01:30Z  in 4000 + out 2000 + cw 2000 + cr 10000
//
// Per-message weighted token count `tok` (effectiveRate → out ×5, cw ×2, cr ×0.1; else ×1):
//                       RAW+cache  RAW-cache  EFFECTIVE+cache         EFFECTIVE-cache
//   msg_cur_A             12000      3000      2000+5000+2000+800=9800  2000+5000=7000
//   msg_cur_C_subagent    12000      3000                       9800             7000
//   msg_other_D           18000      6000      4000+10000+4000+1000=19000 4000+10000=14000
//
// Rate arithmetic (windowSec = 120; the triplicated A counts once via dedup). `all` sums
// every session; `bySession[sessCUR]` sums sessCUR's main + subagent; each is rounded
// independently (so bySession need not sum exactly to `all`):
//   EFFECTIVE + cache (default): all = (9800+9800+19000)/120 = 321.7 → 322
//                                sessCUR = (9800+9800)/120 = 163.3 → 163; sessOTHER = 19000/120 → 158
//   EFFECTIVE, cache excluded:   all = 233; sessCUR = 117; sessOTHER = 117
//   RAW + cache:                 all = 350; sessCUR = 200; sessOTHER = 150
//   RAW, cache excluded:         all = 100; sessCUR =  50; sessOTHER =  50
//
// Active-session / sub-agent counts come from a SEPARATE signal — transcript file mtimes
// over CCSS_ACTIVE_WINDOW — not the token window. Because file mtimes are real disk state
// (not the fixture NOW), the render tests inject a deterministic FILES fixture into the
// snapshot rather than depend on when the fixtures were last touched. All three touched
// just before NOW → countActive gives sessions = { sessCUR, sessOTHER } = 2,
// subagents = { …/agent-x } = 1 → "2=>1".
// ──────────────────────────────────────────────────────────────────────────

const NOW = 1_780_228_920_000;

const PROJECTS_DIR = new URL('./fixtures/projects', import.meta.url).pathname;

// Default config: effective rate + cache, weekly off — matching parseConfig defaults.
const config: Config = {
  quota: 125,
  windowSec: 120,
  activeWindowSec: 15,
  includeCache: true,
  effectiveRate: true,
  showWeekly: false,
  cells: 10,
  ccusageRefreshSec: 30,
  lookbackMs: 120 * 1000 + 60_000,
  tailBytes: 1_048_576,
  projectsDir: PROJECTS_DIR,
};

// Deterministic activity fixture for the render tests → countActive gives 2=>1.
const FILES: FileActivity[] = [
  { session: 'sessCUR', subagent: null, mtimeMs: NOW - 1000 },
  { session: 'sessCUR', subagent: `${PROJECTS_DIR}/enc-cur/sessCUR/subagents/agent-x.jsonl`, mtimeMs: NOW - 1000 },
  { session: 'sessOTHER', subagent: null, mtimeMs: NOW - 1000 },
];

describe('e2e: gatherEntries + computeRatesBySession', () => {
  test('effective + cache (default): all + per-session slices; dedup; out-of-window excluded', async () => {
    const { entries } = await gatherEntries(config, NOW);
    expect(computeRatesBySession(entries, NOW, config.windowSec * 1000)).toEqual({
      all: 322,
      bySession: { sessCUR: 163, sessOTHER: 158 },
    });
  });

  test('effective, cache excluded: input + output×5 only', async () => {
    const noCache: Config = { ...config, includeCache: false };
    const { entries } = await gatherEntries(noCache, NOW);
    expect(computeRatesBySession(entries, NOW, noCache.windowSec * 1000)).toEqual({
      all: 233,
      bySession: { sessCUR: 117, sessOTHER: 117 },
    });
  });

  test('raw + cache: every component weight 1, matches ccusage total tokens', async () => {
    const raw: Config = { ...config, effectiveRate: false };
    const { entries } = await gatherEntries(raw, NOW);
    expect(computeRatesBySession(entries, NOW, raw.windowSec * 1000)).toEqual({
      all: 350,
      bySession: { sessCUR: 200, sessOTHER: 150 },
    });
  });

  test('raw, cache excluded: only input + output counted', async () => {
    const raw: Config = { ...config, effectiveRate: false, includeCache: false };
    const { entries } = await gatherEntries(raw, NOW);
    expect(computeRatesBySession(entries, NOW, raw.windowSec * 1000)).toEqual({
      all: 100,
      bySession: { sessCUR: 50, sessOTHER: 50 },
    });
  });

  test('files: one FileActivity per token-bearing transcript; usage-less journal.jsonl excluded', async () => {
    const { files } = await gatherEntries(config, NOW);
    // The walk sees 4 files, but journal.jsonl (a sibling of agent-x.jsonl with no
    // message.usage) produces no token events, so gatherEntries' `entries.length > 0`
    // guard drops it — only the 3 real transcripts become activity. Classify by path.
    const byKey = files.map((f) => ({ session: f.session, subagent: f.subagent })).sort((a, b) =>
      (a.subagent ?? a.session).localeCompare(b.subagent ?? b.session),
    );
    expect(byKey).toEqual(
      [
        sessionOrigin(`${PROJECTS_DIR}/enc-cur/sessCUR.jsonl`),
        sessionOrigin(`${PROJECTS_DIR}/enc-cur/sessCUR/subagents/agent-x.jsonl`),
        sessionOrigin(`${PROJECTS_DIR}/enc-other/sessOTHER.jsonl`),
      ].sort((a, b) => (a.subagent ?? a.session).localeCompare(b.subagent ?? b.session)),
    );
    expect(files.some((f) => f.subagent?.endsWith('journal.jsonl'))).toBe(false);
    expect(files.every((f) => Number.isFinite(f.mtimeMs))).toBe(true);
    expect(files).toHaveLength(3);
  });
});

describe('e2e: buildStatusline full render (from a snapshot)', () => {
  const input: StatuslineInput = {
    model: { display_name: 'Opus 4.8 (1M context)', id: 'claude-opus-4-8[1m]' },
    effort: { level: 'xhigh' },
    session_id: 'sessCUR',
  };

  // Canned ccusage line → session=13.5, today=330, block=31.25, burn=$13.18/hr, timeLeft=2h 35m.
  const ccusageLine =
    '🤖 Opus 4.8 (1M context) | 💰 $13.50 session / $330.00 today / $31.25 block (2h 35m left) | 🔥 $13.18/hr | 🧠 1,000 (2%)';

  // block=31.25 → round 31 → pct=round((125-31)/125*100)=75 → green.
  const pct = 75;
  const quotaColored = truecolor(`${pct}% ${renderBar(pct, 10)}`, quotaRgb(pct));

  // Build the shared snapshot the way a leader/local tick would, injecting deterministic FILES.
  const snapshotOf = async (cfg: Config, limits: MergedRateLimits | null, line: string | null) => {
    const { entries } = await gatherEntries(cfg, NOW);
    return buildSnapshot(entries, FILES, NOW, cfg, limits, line);
  };

  test('effective default (no first-party limits) → ⭐️ {163}322t/s 2=>1, ⚡ from ccusage estimate', async () => {
    const shared = await snapshotOf(config, null, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config });
    const expected =
      '🤖 Opus 4.8-1m (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {163}322t/s 2=>1' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ 2h 35m ${quotaColored}`;
    expect(actual).toBe(expected);
  });

  test('session $ comes from stdin cost.total_cost_usd, not the ccusage line', async () => {
    const withCost: StatuslineInput = { ...input, cost: { total_cost_usd: 42.4 } };
    const shared = await snapshotOf(config, null, ccusageLine);
    const actual = buildStatusline({ input: withCost, shared, now: NOW, config });
    // block/today still from ccusage (31 / 330), but session is the stdin figure.
    expect(actual).toContain('💰 $42.4 / $31 / $330');
  });

  test('raw mode (CCSS_EFFECTIVE=0) → 🌟 {200}350t/s 2=>1', async () => {
    const raw: Config = { ...config, effectiveRate: false };
    const shared = await snapshotOf(raw, null, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: raw });
    const expected =
      '🤖 Opus 4.8-1m (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | 🌟 {200}350t/s 2=>1' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ 2h 35m ${quotaColored}`;
    expect(actual).toBe(expected);
  });

  test('stale activity (no fresh files) → rate still renders, but no session/sub-agent suffix', async () => {
    const stale: FileActivity[] = FILES.map((f) => ({ ...f, mtimeMs: NOW - 60_000 }));
    const { entries } = await gatherEntries(config, NOW);
    const shared = buildSnapshot(entries, stale, NOW, config, null, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config });
    expect(actual).toContain('⭐️ {163}322t/s |'); // rate present, no "N=>M" before the pipe
    expect(actual).not.toContain('=>');
  });

  test('a follower with no throughput of its own shows cur 0 against the shared all', async () => {
    // A different session reads the same snapshot — its slice is absent → cur 0, all 322.
    const other: StatuslineInput = { ...input, session_id: 'sessBRANDNEW' };
    const shared = await snapshotOf(config, null, ccusageLine);
    const actual = buildStatusline({ input: other, shared, now: NOW, config });
    expect(actual).toContain('⭐️ {0}322t/s 2=>1');
  });
});

describe('e2e: buildStatusline with merged rate limits', () => {
  // The ⚡ bars read from the snapshot's merged limits (resets_at is epoch SECONDS).
  // five_hour: used 40% → 60% left; resets in 1h 5m (minutes shown).
  // seven_day: used 80% → 20% left; resets in 3d 2h (days+hours, no minutes).
  const SEVEN_DAY = { used_percentage: 80, resets_at: NOW / 1000 + (3 * 24 + 2) * 3600 };
  const FIVE_HOUR = { used_percentage: 40, resets_at: NOW / 1000 + 3600 + 5 * 60 };
  const input: StatuslineInput = {
    model: { display_name: 'Fable 5', id: 'claude-fable-5' },
    effort: { level: 'xhigh' },
    session_id: 'sessCUR',
  };

  const ccusageLine =
    '🤖 Fable 5 | 💰 $13.50 session / $330.00 today / $31.25 block (2h 35m left) | 🔥 $13.18/hr | 🧠 1,000 (2%)';

  const twoBars = (fhPct: number, fhT: string, wdPct: number, wdT: string): string =>
    `⚡ ${fhT} ${truecolor(`${fhPct}% ${renderBar(fhPct, 10)}`, quotaRgb(fhPct))}` +
    ` ${wdT} ${truecolor(`${wdPct}% ${renderBar(wdPct, 10)}`, quotaRgb(wdPct))}`;
  const ccColored = truecolor(`75% ${renderBar(75, 10)}`, quotaRgb(75));
  const weekly: Config = { ...config, showWeekly: true };

  const snapshotOf = async (cfg: Config, limits: MergedRateLimits | null, line: string | null) => {
    const { entries } = await gatherEntries(cfg, NOW);
    return buildSnapshot(entries, FILES, NOW, cfg, limits, line);
  };

  test('⚡ shows the merged five_hour + seven_day as two bars, not the ccusage $ estimate', async () => {
    const shared = await snapshotOf(weekly, { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY }, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    const expected =
      '🤖 Fable 5 (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {163}322t/s 2=>1' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ${twoBars(60, '1h 5m', 20, '3d 2h')}`;
    expect(actual).toBe(expected);
  });

  test('⚡ renders from merged limits even when the snapshot has no ccusage line', async () => {
    const shared = await snapshotOf(weekly, { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY }, null);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    expect(actual).toBe(
      `🤖 Fable 5 (ultracode) | ⭐️ {163}322t/s 2=>1 | ${twoBars(60, '1h 5m', 20, '3d 2h')}`,
    );
  });

  test('null five_hour fields + no seven_day → single ccusage bar only', async () => {
    const limits = { five_hour: { used_percentage: null, resets_at: null } } as unknown as MergedRateLimits;
    const shared = await snapshotOf(weekly, limits, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    expect(actual).toContain(`⚡ 2h 35m ${ccColored}`);
    expect(actual.endsWith(`⚡ 2h 35m ${ccColored}`)).toBe(true);
  });

  test('five_hour absent but seven_day present → ccusage 5h bar beside the weekly bar', async () => {
    const shared = await snapshotOf(weekly, { seven_day: SEVEN_DAY }, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    expect(actual).toContain(twoBars(75, '2h 35m', 20, '3d 2h'));
  });

  test('weekly disabled by default (showWeekly:false) → only the 5h bar even with seven_day present', async () => {
    const shared = await snapshotOf(config, { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY }, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config });
    const fhOnly = `⚡ 1h 5m ${truecolor(`60% ${renderBar(60, 10)}`, quotaRgb(60))}`;
    expect(actual).toContain(fhOnly);
    expect(actual.endsWith(fhOnly)).toBe(true);
  });
});

describe('e2e: idle', () => {
  test('10 minutes past last activity → all 0, no fresh files → "⭐️ 0t/s"', async () => {
    const idleNow = NOW + 10 * 60 * 1000;
    const { entries } = await gatherEntries(config, idleNow);
    expect(computeRatesBySession(entries, idleNow, config.windowSec * 1000)).toEqual({
      all: 0,
      bySession: {},
    });

    const { formatSpeed } = await import('../src/format');
    const { countActive } = await import('../src/transcripts');
    const stale: FileActivity[] = FILES.map((f) => ({ ...f, mtimeMs: NOW }));
    const counts = countActive(stale, idleNow, config.activeWindowSec * 1000);
    expect(counts).toEqual({ sessions: 0, subagents: 0 });
    expect(formatSpeed({ cur: 0, all: 0 }, counts, config.effectiveRate)).toBe('⭐️ 0t/s');
  });
});
