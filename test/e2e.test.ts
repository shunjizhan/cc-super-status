import { describe, expect, test } from 'bun:test';

import type { Config, FileActivity, StatuslineInput } from '../src/types';
import { gatherEntries, sessionOrigin } from '../src/transcripts';
import { computeRate } from '../src/rate';
import { buildStatusline } from '../src/buildStatusline';
import { quotaRgb, renderBar, truecolor } from '../src/format';

// ──────────────────────────────────────────────────────────────────────────
// Deterministic e2e against on-disk fixtures.
//
// NOW = 1_780_228_920_000 ms = 2026-05-31T12:02:00.000Z.
// windowSec = 120 → windowMs = 120_000 → winStart = NOW - 120s = 2026-05-31T12:00:00Z.
// Window is [12:00:00Z, 12:02:00Z] inclusive (end = max(now, maxTs) = now; no future ts).
//
// Fixtures under test/fixtures/projects/. Per message:
//   enc-cur/sessCUR.jsonl                       (current session, main transcript)
//     · msg_out_of_window  @ 11:59:00Z  in 50000 + out 50000 → BEFORE winStart → EXCLUDED
//     · msg_cur_A          @ 12:01:00Z  in 2000 + out 1000 + cw 1000 + cr 8000  (current, ×3 dup rows)
//   enc-cur/sessCUR/subagents/agent-x.jsonl     (current session, subagent)
//     · msg_cur_C_subagent @ 12:00:30Z  in 2000 + out 1000 + cw 1000 + cr 8000  (current)
//   enc-other/sessOTHER.jsonl                   (a DIFFERENT session)
//     · msg_other_D        @ 12:01:30Z  in 4000 + out 2000 + cw 2000 + cr 10000 (NON-current)
//
// Per-message weighted token count `tok` (effectiveRate → out ×5, cw ×2, cr ×0.1; else ×1):
//                       RAW+cache  RAW-cache  EFFECTIVE+cache         EFFECTIVE-cache
//   msg_cur_A             12000      3000      2000+5000+2000+800=9800  2000+5000=7000
//   msg_cur_C_subagent    12000      3000                       9800             7000
//   msg_other_D           18000      6000      4000+10000+4000+1000=19000 4000+10000=14000
//
// Rate arithmetic (windowSec = 120; the triplicated A counts once via dedup):
//   EFFECTIVE + cache (the default): cur = (9800+9800)/120 = 163.3 → 163
//                                    all = (9800+9800+19000)/120 = 321.7 → 322
//   EFFECTIVE, cache excluded:       cur = (7000+7000)/120 = 116.7 → 117
//                                    all = (7000+7000+14000)/120 = 233.3 → 233
//   RAW + cache:                     cur = 24000/120 = 200 ;  all = 42000/120 = 350
//   RAW, cache excluded:             cur =  6000/120 =  50 ;  all = 12000/120 = 100
//
// Active-session / sub-agent counts come from a SEPARATE signal — transcript file
// mtimes over CCSS_ACTIVE_WINDOW — not the token window. Because file mtimes are
// real wall-clock disk state (not the fixture NOW), the render tests below inject
// a deterministic FILES fixture rather than depend on when the fixtures were last
// touched on disk. With all three transcripts touched just before NOW, the counts
// are sessions = { sessCUR, sessOTHER } = 2, subagents = { …/agent-x } = 1 → "2=>1".
// ──────────────────────────────────────────────────────────────────────────

const NOW = 1_780_228_920_000;

// Resolve the fixtures projects dir relative to this test file.
const PROJECTS_DIR = new URL('./fixtures/projects', import.meta.url).pathname;
const CUR_TRANSCRIPT = `${PROJECTS_DIR}/enc-cur/sessCUR.jsonl`;

// Default config: effective rate + cache, weekly off — matching statusline.ts defaults.
const config: Config = {
  quota: 125,
  windowSec: 120,
  activeWindowSec: 15,
  includeCache: true,
  effectiveRate: true,
  showWeekly: false,
  cells: 10,
  lookbackMs: 120 * 1000 + 60_000,
  tailBytes: 1_048_576,
  projectsDir: PROJECTS_DIR,
};

// Deterministic activity fixture for the render tests (file mtimes are real disk
// state, so we don't read them off the fixtures): both sessions + the one subagent
// touched just before NOW → countActive gives { sessions: 2, subagents: 1 } → "2=>1".
const FILES: FileActivity[] = [
  { session: 'sessCUR', subagent: null, mtimeMs: NOW - 1000 },
  { session: 'sessCUR', subagent: `${PROJECTS_DIR}/enc-cur/sessCUR/subagents/agent-x.jsonl`, mtimeMs: NOW - 1000 },
  { session: 'sessOTHER', subagent: null, mtimeMs: NOW - 1000 },
];

describe('e2e: gatherEntries + computeRate', () => {
  test('effective + cache (default): cur from current main+subagent; all adds other session; dedup; out-of-window excluded', async () => {
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, config.windowSec * 1000);
    expect(rates).toEqual({ cur: 163, all: 322 });
  });

  test('effective, cache excluded: input + output×5 only', async () => {
    const noCache: Config = { ...config, includeCache: false };
    const { entries } = await gatherEntries(noCache, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, noCache.windowSec * 1000);
    expect(rates).toEqual({ cur: 117, all: 233 });
  });

  test('raw + cache: every component weight 1, matches ccusage total tokens', async () => {
    const raw: Config = { ...config, effectiveRate: false };
    const { entries } = await gatherEntries(raw, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, raw.windowSec * 1000);
    expect(rates).toEqual({ cur: 200, all: 350 });
  });

  test('raw, cache excluded: only input + output counted', async () => {
    const raw: Config = { ...config, effectiveRate: false, includeCache: false };
    const { entries } = await gatherEntries(raw, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, raw.windowSec * 1000);
    expect(rates).toEqual({ cur: 50, all: 100 });
  });

  test('files: one FileActivity per token-bearing transcript; usage-less journal.jsonl excluded', async () => {
    const { files } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
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
    // Explicit guard on the exclusion: no activity record points at the journal —
    // without the guard it would be counted as a phantom sub-agent.
    expect(files.some((f) => f.subagent?.endsWith('journal.jsonl'))).toBe(false);
    // Every record carries a finite mtime (real disk time — we don't assert its value).
    expect(files.every((f) => Number.isFinite(f.mtimeMs))).toBe(true);
    expect(files).toHaveLength(3);
  });
});

describe('e2e: buildStatusline full render', () => {
  const input: StatuslineInput = {
    model: { display_name: 'Opus 4.8 (1M context)', id: 'claude-opus-4-8[1m]' },
    effort: { level: 'xhigh' },
    transcript_path: CUR_TRANSCRIPT,
    session_id: 'sessCUR',
  };

  // Canned ccusage line → session=13.5, today=330, block=31.25, burn=$13.18/hr, timeLeft=2h 35m.
  const ccusageLine =
    '🤖 Opus 4.8 (1M context) | 💰 $13.50 session / $330.00 today / $31.25 block (2h 35m left) | 🔥 $13.18/hr | 🧠 1,000 (2%)';

  // block=31.25 → pct=75 → green.
  const pct = 75; // round((125 - 31.25) / 125 * 100) = round(75) = 75
  const quotaColored = truecolor(`${pct}% ${renderBar(pct, 10)}`, quotaRgb(pct));

  test('effective default → ⭐️ {163}322t/s 2=>1', async () => {
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input, ccusageLine, entries, files: FILES, now: NOW, config });
    const expected =
      '🤖 Opus 4.8-1m (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {163}322t/s 2=>1' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ 2h 35m ${quotaColored}`;
    expect(actual).toBe(expected);
  });

  test('raw mode (CCSS_EFFECTIVE=0) → 🌟 {200}350t/s 2=>1', async () => {
    const raw: Config = { ...config, effectiveRate: false };
    const { entries } = await gatherEntries(raw, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input, ccusageLine, entries, files: FILES, now: NOW, config: raw });
    const expected =
      '🤖 Opus 4.8-1m (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | 🌟 {200}350t/s 2=>1' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ 2h 35m ${quotaColored}`;
    expect(actual).toBe(expected);
  });

  test('stale activity (no fresh files) → rate still renders, but no session/sub-agent suffix', async () => {
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    // All files touched well before NOW → countActive drops them → suffix suppressed.
    const stale: FileActivity[] = FILES.map((f) => ({ ...f, mtimeMs: NOW - 60_000 }));
    const actual = buildStatusline({ input, ccusageLine, entries, files: stale, now: NOW, config });
    expect(actual).toContain('⭐️ {163}322t/s |'); // rate present, no "N=>M" before the pipe
    expect(actual).not.toContain('=>');
  });
});

describe('e2e: buildStatusline with first-party rate limits', () => {
  // Claude Code ≥2.1.132 (Pro/Max) passes rate_limits on stdin; resets_at is epoch SECONDS.
  // five_hour: used 40% → 60% left; resets in 1h 5m (minutes shown).
  // seven_day: used 80% → 20% left; resets in 3d 2h (days+hours, no minutes).
  // Both intentionally differ from the canned ccusage block (75% / 2h 35m) to
  // prove the first-party data wins over the ccusage $ estimate.
  const SEVEN_DAY = { used_percentage: 80, resets_at: NOW / 1000 + (3 * 24 + 2) * 3600 };
  const input: StatuslineInput = {
    model: { display_name: 'Fable 5', id: 'claude-fable-5' },
    effort: { level: 'xhigh' },
    transcript_path: CUR_TRANSCRIPT,
    session_id: 'sessCUR',
    rate_limits: {
      five_hour: { used_percentage: 40, resets_at: NOW / 1000 + 3600 + 5 * 60 },
      seven_day: SEVEN_DAY,
    },
  };

  const ccusageLine =
    '🤖 Fable 5 | 💰 $13.50 session / $330.00 today / $31.25 block (2h 35m left) | 🔥 $13.18/hr | 🧠 1,000 (2%)';

  // ⚡ segment: one solid bar per window, space-separated, each "<time> <pct>% <bar>".
  const twoBars = (fhPct: number, fhT: string, wdPct: number, wdT: string): string =>
    `⚡ ${fhT} ${truecolor(`${fhPct}% ${renderBar(fhPct, 10)}`, quotaRgb(fhPct))}` +
    ` ${wdT} ${truecolor(`${wdPct}% ${renderBar(wdPct, 10)}`, quotaRgb(wdPct))}`;
  // Single-window bar (only one lane present).
  const ccColored = truecolor(`75% ${renderBar(75, 10)}`, quotaRgb(75));
  // Weekly bar is opt-in; these tests exercise it enabled (default is off — see below).
  const weekly: Config = { ...config, showWeekly: true };

  test('⚡ shows first-party five_hour + seven_day as two bars, not the ccusage $ estimate', async () => {
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input, ccusageLine, entries, files: FILES, now: NOW, config: weekly });
    const expected =
      '🤖 Fable 5 (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {163}322t/s 2=>1' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ${twoBars(60, '1h 5m', 20, '3d 2h')}`;
    expect(actual).toBe(expected);
  });

  test('⚡ renders from rate_limits even when ccusage is unavailable', async () => {
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input, ccusageLine: null, entries, files: FILES, now: NOW, config: weekly });
    expect(actual).toBe(
      `🤖 Fable 5 (ultracode) | ⭐️ {163}322t/s 2=>1 | ${twoBars(60, '1h 5m', 20, '3d 2h')}`,
    );
  });

  test('null five_hour fields + no seven_day → single ccusage bar only', async () => {
    const nullFields = {
      ...input,
      rate_limits: { five_hour: { used_percentage: null, resets_at: null } },
    } as unknown as StatuslineInput;
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input: nullFields, ccusageLine, entries, files: FILES, now: NOW, config: weekly });
    expect(actual).toContain(`⚡ 2h 35m ${ccColored}`);
    expect(actual.endsWith(`⚡ 2h 35m ${ccColored}`)).toBe(true); // only one window; nothing trails it
  });

  test('five_hour absent but seven_day present → ccusage 5h bar beside the weekly bar', async () => {
    const noFiveHour: StatuslineInput = {
      ...input,
      rate_limits: { seven_day: SEVEN_DAY },
    };
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input: noFiveHour, ccusageLine, entries, files: FILES, now: NOW, config: weekly });
    // 5h bar from ccusage ($31.25/125 → 75%, 2h 35m); 7d bar from seven_day (20%, 3d 2h).
    expect(actual).toContain(twoBars(75, '2h 35m', 20, '3d 2h'));
  });

  test('weekly disabled by default (showWeekly:false) → only the 5h bar even with seven_day present', async () => {
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    // Same `input` (both windows present) but the default config has showWeekly off.
    const actual = buildStatusline({ input, ccusageLine, entries, files: FILES, now: NOW, config });
    // 5h from first-party five_hour (60%, 1h 5m); the weekly window is suppressed entirely.
    const fhOnly = `⚡ 1h 5m ${truecolor(`60% ${renderBar(60, 10)}`, quotaRgb(60))}`;
    expect(actual).toContain(fhOnly);
    expect(actual.endsWith(fhOnly)).toBe(true); // nothing trails — no weekly bar
  });
});

describe('e2e: idle', () => {
  test('10 minutes past last activity → {cur:0, all:0}, no fresh files → "⭐️ 0t/s"', async () => {
    const idleNow = NOW + 10 * 60 * 1000;
    const { entries } = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', idleNow);
    const rates = computeRate(entries, idleNow, config.windowSec * 1000);
    expect(rates).toEqual({ cur: 0, all: 0 });

    const { formatSpeed } = await import('../src/format');
    const { countActive } = await import('../src/transcripts');
    // Nothing touched within the active window (all activity is 10 min old) → no counts.
    // (Synthetic stale files: real fixture mtimes are wall-clock, kept out of the assertion.)
    const stale: FileActivity[] = FILES.map((f) => ({ ...f, mtimeMs: NOW }));
    const counts = countActive(stale, idleNow, config.activeWindowSec * 1000);
    expect(counts).toEqual({ sessions: 0, subagents: 0 });
    expect(formatSpeed(rates, counts, config.effectiveRate)).toBe('⭐️ 0t/s');
  });
});
