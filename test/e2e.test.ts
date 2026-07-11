import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CachedTailState, Config, FileActivity, MergedRateLimits, StatuslineInput } from '../src/types';
import { countActive, gatherEntries, sessionOrigin } from '../src/transcripts';
import { computeRatesBySession } from '../src/rate';
import { buildSnapshot } from '../src/shared';
import { buildStatusline } from '../src/buildStatusline';
import { DIM, dimColor, layerColor, truecolor } from '../src/format';

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
// Active-session / sub-agent counts come from a SEPARATE signal — each transcript
// tail's classified turn state (busy / error / ended), with mtime only as a corpse
// TTL and as the freshness window for unclassifiable ('unknown') files — not the
// token window. Because the fixtures' live states/mtimes are real disk state (not
// the fixture NOW), the render tests inject a deterministic FILES fixture into the
// snapshot rather than depend on the on-disk classification. All three busy just
// before NOW → countActive gives sessions = { sessCUR, sessOTHER } = 2,
// subagents = { …/agent-x } = 1 → "2[1]".
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
  layers: 1,
  ccusageRefreshSec: 30,
  lookbackMs: 120 * 1000 + 60_000,
  tailBytes: 1_048_576,
  projectsDir: PROJECTS_DIR,
};

// Expected ⚡ lane for a 1-layer plan (Pro / 5x — the e2e config): a single emerald→amber→red
// bar — `solid = floor(pct/10)` fully-held cells, then the single dim FRONTIER cell being
// consumed, then the dim gray track. displayPct == pct at layers=1. Mirrors renderLane;
// layerColor/dimColor/DIM are pinned to literals in format.test.ts.
const bar1 = (pct: number, timeLeft: string): string => {
  const rgb = layerColor(1, pct);
  const solid = Math.min(Math.max(Math.floor((pct / 100) * 10), 0), 10);
  const hasFrontier = solid < 10;
  const empty = 10 - solid - (hasFrontier ? 1 : 0);
  const solidRun = solid > 0 ? truecolor('▰'.repeat(solid), rgb) : '';
  const frontier = hasFrontier ? truecolor('▰', dimColor(rgb)) : '';
  const emptyRun = empty > 0 ? truecolor('▰'.repeat(empty), DIM) : '';
  return `${timeLeft} ${truecolor(`${pct}%`, rgb)} ${solidRun}${frontier}${emptyRun}`;
};

// Deterministic activity fixture for the render tests → countActive gives 2[1].
const FILES: FileActivity[] = [
  { session: 'sessCUR', subagent: null, mtimeMs: NOW - 1000, state: 'busy', stateAtMs: NOW - 1000 },
  { session: 'sessCUR', subagent: `${PROJECTS_DIR}/enc-cur/sessCUR/subagents/agent-x.jsonl`, mtimeMs: NOW - 1000, state: 'busy', stateAtMs: NOW - 1000 },
  { session: 'sessOTHER', subagent: null, mtimeMs: NOW - 1000, state: 'busy', stateAtMs: NOW - 1000 },
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

  test('files: one FileActivity per real transcript; classifier-blind journal.jsonl excluded', async () => {
    const { files, states } = await gatherEntries(config, NOW);
    // The walk sees 4 files, but journal.jsonl (a sibling of agent-x.jsonl with no
    // user/assistant rows) classifies to no turn state and yields no token events,
    // so gatherEntries drops it — only the 3 real transcripts become activity.
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
    // Fixture rows are assistant messages without stop_reason → mid-flush → stalled.
    expect(files.every((f) => f.state === 'stalled')).toBe(true);
    // Every looked-at transcript (including journal.jsonl, cached as null) is in the state cache.
    expect(Object.keys(states)).toHaveLength(4);
    expect(Object.entries(states).find(([p]) => p.endsWith('journal.jsonl'))?.[1].state).toBe(null);
    expect(files).toHaveLength(3);
  });
});

describe('e2e: turn-state lane + snapshot cache (beyond the rate lookback)', () => {
  // Scratch projects dir with explicit utimes — the only way to exercise the
  // rateFresh=false lane deterministically (the checked-in fixtures are always
  // mtime-fresh relative to NOW).
  const AGE_MS = 4 * 60_000; // inside STATE_LOOKBACK (35min), outside lookbackMs (~3min)
  const mkProjects = (rows: string): { dir: string; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'ccss-e2e-'));
    mkdirSync(join(dir, 'enc'), { recursive: true });
    const file = join(dir, 'enc', 'sessOLD.jsonl');
    writeFileSync(file, rows);
    const mtime = new Date(NOW - AGE_MS);
    utimesSync(file, mtime, mtime);
    return { dir, file };
  };
  // A busy tail with a token-bearing assistant row — proves the token parse is
  // suppressed by the lane, not by an absence of usage.
  const busyRows =
    JSON.stringify({ type: 'assistant', timestamp: '2026-05-31T11:57:00.000Z', message: { id: 'mOLD', stop_reason: 'tool_use', usage: { input_tokens: 999 } } }) + '\n';
  const BUSY_AT_MS = Date.parse('2026-05-31T11:57:00.000Z');

  test('state lane: activity classified, token parse suppressed, state cached by path', async () => {
    const { dir, file } = mkProjects(busyRows);
    const cfg: Config = { ...config, projectsDir: dir };
    const { entries, files, states } = await gatherEntries(cfg, NOW);
    expect(entries).toEqual([]); // beyond the rate lookback → no token events
    expect(files).toEqual([{ session: 'sessOLD', subagent: null, mtimeMs: NOW - AGE_MS, state: 'busy', stateAtMs: BUSY_AT_MS }]);
    expect(states[file]).toEqual({ mtimeMs: NOW - AGE_MS, state: 'busy', stateAtMs: BUSY_AT_MS });
  });

  test('metadata-only file updates do not resurrect an old unfinished prompt', async () => {
    const oldPrompt = JSON.stringify({
      type: 'user',
      timestamp: new Date(NOW - 31 * 60_000).toISOString(),
      message: { role: 'user', content: 'abandoned prompt' },
    });
    const metadata = JSON.stringify({ type: 'permission-mode', permissionMode: 'default' });
    const { dir } = mkProjects(`${oldPrompt}\n${metadata}\n`);
    const cfg: Config = { ...config, projectsDir: dir };

    const first = await gatherEntries(cfg, NOW);
    const cached = await gatherEntries(cfg, NOW, first.states);

    expect([
      countActive(first.files, NOW, cfg.activeWindowSec * 1000),
      countActive(cached.files, NOW, cfg.activeWindowSec * 1000),
    ]).toEqual([
      { sessions: 0, subagents: 0 },
      { sessions: 0, subagents: 0 },
    ]);
  });

  test('a state row without a usable timestamp uses the short fallback window', async () => {
    const prompt = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'prompt without timestamp' },
    });
    const { dir } = mkProjects(`${prompt}\n`);
    const cfg: Config = { ...config, projectsDir: dir };

    const { files } = await gatherEntries(cfg, NOW);

    expect({ state: files[0]?.state, counts: countActive(files, NOW, cfg.activeWindowSec * 1000) }).toEqual({
      state: 'unknown',
      counts: { sessions: 0, subagents: 0 },
    });
  });

  test('a recent tool result keeps a long-running tool turn active', async () => {
    const dispatch = JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW - 31 * 60_000).toISOString(),
      message: { id: 'mLONG', stop_reason: 'tool_use' },
    });
    const result = JSON.stringify({
      type: 'user',
      timestamp: new Date(NOW - AGE_MS).toISOString(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    });
    const { dir } = mkProjects(`${dispatch}\n${result}\n`);
    const cfg: Config = { ...config, projectsDir: dir };

    const { files } = await gatherEntries(cfg, NOW);

    expect(countActive(files, NOW, cfg.activeWindowSec * 1000)).toEqual({ sessions: 1, subagents: 0 });
  });

  test('a tool result without a timestamp uses the short fallback window', async () => {
    const dispatch = JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW - 31 * 60_000).toISOString(),
      message: { id: 'mLONG', stop_reason: 'tool_use' },
    });
    const result = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    });
    const { dir } = mkProjects(`${dispatch}\n${result}\n`);
    const cfg: Config = { ...config, projectsDir: dir };

    const { files } = await gatherEntries(cfg, NOW);

    expect({ state: files[0]?.state, counts: countActive(files, NOW, cfg.activeWindowSec * 1000) }).toEqual({
      state: 'unknown',
      counts: { sessions: 0, subagents: 0 },
    });
  });

  test('a future row and file mtime cannot extend the busy TTL past now', async () => {
    const future = new Date(NOW + 60 * 60_000);
    const prompt = JSON.stringify({
      type: 'user',
      timestamp: future.toISOString(),
      message: { role: 'user', content: 'future-clock prompt' },
    });
    const { dir, file } = mkProjects(`${prompt}\n`);
    utimesSync(file, future, future);
    const cfg: Config = { ...config, projectsDir: dir };

    const { files } = await gatherEntries(cfg, NOW);

    expect(countActive(files, NOW + 30 * 60_000 + 1, cfg.activeWindowSec * 1000)).toEqual({
      sessions: 0,
      subagents: 0,
    });
  });

  test('cache hit (matching mtime) skips the read — the cached state wins over the tail', async () => {
    const { dir, file } = mkProjects(busyRows);
    const cfg: Config = { ...config, projectsDir: dir };
    const prev = { [file]: { mtimeMs: NOW - AGE_MS, state: 'ended' as const, stateAtMs: NOW - AGE_MS } };
    const { files, states } = await gatherEntries(cfg, NOW, prev);
    // The tail says busy, but the mtime-valid cache says ended → no read happened.
    expect(files).toEqual([{ session: 'sessOLD', subagent: null, mtimeMs: NOW - AGE_MS, state: 'ended', stateAtMs: NOW - AGE_MS }]);
    expect(states[file]).toEqual({ mtimeMs: NOW - AGE_MS, state: 'ended', stateAtMs: NOW - AGE_MS });
  });

  test('a legacy cache entry without state time is reclassified', async () => {
    const { dir, file } = mkProjects(busyRows);
    const cfg: Config = { ...config, projectsDir: dir };
    const legacy = {
      [file]: { mtimeMs: NOW - AGE_MS, state: 'ended' },
    } as unknown as Record<string, CachedTailState>;

    const { files, states } = await gatherEntries(cfg, NOW, legacy);

    expect({ file: files[0], cached: states[file] }).toEqual({
      file: { session: 'sessOLD', subagent: null, mtimeMs: NOW - AGE_MS, state: 'busy', stateAtMs: BUSY_AT_MS },
      cached: { mtimeMs: NOW - AGE_MS, state: 'busy', stateAtMs: BUSY_AT_MS },
    });
  });

  test('cache invalidation: a different cached mtime forces a fresh classification', async () => {
    const { dir, file } = mkProjects(busyRows);
    const cfg: Config = { ...config, projectsDir: dir };
    const prev = { [file]: { mtimeMs: NOW - AGE_MS - 1, state: 'ended' as const, stateAtMs: NOW - AGE_MS - 1 } };
    const { files } = await gatherEntries(cfg, NOW, prev);
    expect(files[0]?.state).toBe('busy');
  });

  test('cached null keeps a classifier-blind file excluded without re-reading it', async () => {
    const { dir, file } = mkProjects(JSON.stringify({ type: 'result' }) + '\n');
    const cfg: Config = { ...config, projectsDir: dir };
    const prev = { [file]: { mtimeMs: NOW - AGE_MS, state: null, stateAtMs: null } };
    const { files, states } = await gatherEntries(cfg, NOW, prev);
    expect(files).toEqual([]);
    expect(states[file]).toEqual({ mtimeMs: NOW - AGE_MS, state: null, stateAtMs: null });
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

  // block=31.25 → round 31 → pct=round((125-31)/125*100)=75 → green. 1-layer bar (no scaling).
  const ccBar = bar1(75, '2h 35m');

  // Build the shared snapshot the way a leader/local tick would, injecting deterministic FILES.
  const snapshotOf = async (cfg: Config, limits: MergedRateLimits | null, line: string | null) => {
    const { entries } = await gatherEntries(cfg, NOW);
    return buildSnapshot(entries, FILES, NOW, cfg, limits, line);
  };

  test('effective default (no first-party limits) → ⭐️ {163}322t/s 2[1], ⚡ from ccusage estimate', async () => {
    const shared = await snapshotOf(config, null, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config });
    const expected =
      '🥷 Opus 4.8 (xhigh)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {163}322t/s 2[1]' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ ${ccBar}`;
    expect(actual).toBe(expected);
  });

  test('session $ comes from stdin cost.total_cost_usd, not the ccusage line', async () => {
    const withCost: StatuslineInput = { ...input, cost: { total_cost_usd: 42.4 } };
    const shared = await snapshotOf(config, null, ccusageLine);
    const actual = buildStatusline({ input: withCost, shared, now: NOW, config });
    // block/today still from ccusage (31 / 330), but session is the stdin figure.
    expect(actual).toContain('💰 $42.4 / $31 / $330');
  });

  test('raw mode (CCSS_EFFECTIVE=0) → 🌟 {200}350t/s 2[1]', async () => {
    const raw: Config = { ...config, effectiveRate: false };
    const shared = await snapshotOf(raw, null, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: raw });
    const expected =
      '🥷 Opus 4.8 (xhigh)' +
      ' | 🔥 $13.18/hr' +
      ' | 🌟 {200}350t/s 2[1]' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ ${ccBar}`;
    expect(actual).toBe(expected);
  });

  test('ended turns → rate still renders, counts drop to 0[0] immediately (no blink-out)', async () => {
    // Freshly-written files whose turns COMPLETED: ended beats mtime freshness.
    const done: FileActivity[] = FILES.map((f) => ({ ...f, state: 'ended' as const }));
    const { entries } = await gatherEntries(config, NOW);
    const shared = buildSnapshot(entries, done, NOW, config, null, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config });
    // The suffix is unconditional: idle shows 0[0] rather than the segment vanishing.
    expect(actual).toContain('⭐️ {163}322t/s 0[0] |');
  });

  test('a follower with no throughput of its own shows cur 0 against the shared all', async () => {
    // A different session reads the same snapshot — its slice is absent → cur 0, all 322.
    const other: StatuslineInput = { ...input, session_id: 'sessBRANDNEW' };
    const shared = await snapshotOf(config, null, ccusageLine);
    const actual = buildStatusline({ input: other, shared, now: NOW, config });
    expect(actual).toContain('⭐️ {0}322t/s 2[1]');
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
    `⚡ ${bar1(fhPct, fhT)} ${bar1(wdPct, wdT)}`;
  const weekly: Config = { ...config, showWeekly: true };

  const snapshotOf = async (cfg: Config, limits: MergedRateLimits | null, line: string | null) => {
    const { entries } = await gatherEntries(cfg, NOW);
    return buildSnapshot(entries, FILES, NOW, cfg, limits, line);
  };

  test('⚡ shows the merged five_hour + seven_day as two bars, not the ccusage $ estimate', async () => {
    const shared = await snapshotOf(weekly, { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY }, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    const expected =
      '🐉 Fable 5 (xhigh)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {163}322t/s 2[1]' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ${twoBars(60, '1h 5m', 20, '3d 2h')}`;
    expect(actual).toBe(expected);
  });

  test('⚡ renders from merged limits even when the snapshot has no ccusage line', async () => {
    const shared = await snapshotOf(weekly, { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY }, null);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    expect(actual).toBe(
      `🐉 Fable 5 (xhigh) | ⭐️ {163}322t/s 2[1] | ${twoBars(60, '1h 5m', 20, '3d 2h')}`,
    );
  });

  test('null five_hour fields + no seven_day → single ccusage bar only', async () => {
    const limits = { five_hour: { used_percentage: null, resets_at: null } } as unknown as MergedRateLimits;
    const shared = await snapshotOf(weekly, limits, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    expect(actual).toContain(`⚡ ${bar1(75, '2h 35m')}`);
    expect(actual.endsWith(`⚡ ${bar1(75, '2h 35m')}`)).toBe(true);
  });

  test('five_hour absent but seven_day present → ccusage 5h bar beside the weekly bar', async () => {
    const shared = await snapshotOf(weekly, { seven_day: SEVEN_DAY }, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config: weekly });
    expect(actual).toContain(twoBars(75, '2h 35m', 20, '3d 2h'));
  });

  test('weekly disabled by default (showWeekly:false) → only the 5h bar even with seven_day present', async () => {
    const shared = await snapshotOf(config, { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY }, ccusageLine);
    const actual = buildStatusline({ input, shared, now: NOW, config });
    const fhOnly = `⚡ ${bar1(60, '1h 5m')}`;
    expect(actual).toContain(fhOnly);
    expect(actual.endsWith(fhOnly)).toBe(true);
  });
});

describe('e2e: idle', () => {
  test('10 minutes past last activity → all 0, no fresh files → "⭐️ 0t/s 0[0]"', async () => {
    const idleNow = NOW + 10 * 60 * 1000;
    const { entries } = await gatherEntries(config, idleNow);
    expect(computeRatesBySession(entries, idleNow, config.windowSec * 1000)).toEqual({
      all: 0,
      bySession: {},
    });

    const { formatSpeed } = await import('../src/format');
    const { countActive } = await import('../src/transcripts');
    // Idle on disk means the tails classified 'ended' — never counted, any mtime.
    const done: FileActivity[] = FILES.map((f) => ({ ...f, mtimeMs: NOW, state: 'ended' as const }));
    const counts = countActive(done, idleNow, config.activeWindowSec * 1000);
    expect(counts).toEqual({ sessions: 0, subagents: 0 });
    // Suffix is unconditional: fully idle renders 0[0], not an empty suffix.
    expect(formatSpeed({ cur: 0, all: 0 }, counts, config.effectiveRate)).toBe('⭐️ 0t/s 0[0]');
  });
});
