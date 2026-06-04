import { describe, expect, test } from 'bun:test';

import type { Config, StatuslineInput } from '../src/types';
import { gatherEntries } from '../src/transcripts';
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
// ──────────────────────────────────────────────────────────────────────────

const NOW = 1_780_228_920_000;

// Resolve the fixtures projects dir relative to this test file.
const PROJECTS_DIR = new URL('./fixtures/projects', import.meta.url).pathname;
const CUR_TRANSCRIPT = `${PROJECTS_DIR}/enc-cur/sessCUR.jsonl`;

// Default config: effective rate + cache, matching statusline.ts defaults.
const config: Config = {
  quota: 125,
  windowSec: 120,
  includeCache: true,
  effectiveRate: true,
  cells: 10,
  lookbackMs: 120 * 1000 + 60_000,
  tailBytes: 1_048_576,
  projectsDir: PROJECTS_DIR,
};

describe('e2e: gatherEntries + computeRate', () => {
  test('effective + cache (default): cur from current main+subagent; all adds other session; dedup; out-of-window excluded', async () => {
    const entries = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, config.windowSec * 1000);
    expect(rates).toEqual({ cur: 163, all: 322 });
  });

  test('effective, cache excluded: input + output×5 only', async () => {
    const noCache: Config = { ...config, includeCache: false };
    const entries = await gatherEntries(noCache, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, noCache.windowSec * 1000);
    expect(rates).toEqual({ cur: 117, all: 233 });
  });

  test('raw + cache: every component weight 1, matches ccusage total tokens', async () => {
    const raw: Config = { ...config, effectiveRate: false };
    const entries = await gatherEntries(raw, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, raw.windowSec * 1000);
    expect(rates).toEqual({ cur: 200, all: 350 });
  });

  test('raw, cache excluded: only input + output counted', async () => {
    const raw: Config = { ...config, effectiveRate: false, includeCache: false };
    const entries = await gatherEntries(raw, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, raw.windowSec * 1000);
    expect(rates).toEqual({ cur: 50, all: 100 });
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
  const quotaColored = truecolor(`${pct}% left ${renderBar(pct, 10)}`, quotaRgb(pct));

  test('effective default → ⭐️ {163}322t/s', async () => {
    const entries = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input, ccusageLine, entries, now: NOW, config });
    const expected =
      '🤖 Opus 4.8-1m (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {163}322t/s' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ 2h 35m, ${quotaColored}`;
    expect(actual).toBe(expected);
  });

  test('raw mode (CCSS_EFFECTIVE=0) → 🌟 {200}350t/s', async () => {
    const raw: Config = { ...config, effectiveRate: false };
    const entries = await gatherEntries(raw, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const actual = buildStatusline({ input, ccusageLine, entries, now: NOW, config: raw });
    const expected =
      '🤖 Opus 4.8-1m (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | 🌟 {200}350t/s' +
      ' | 💰 $13.5 / $31 / $330' +
      ` | ⚡ 2h 35m, ${quotaColored}`;
    expect(actual).toBe(expected);
  });
});

describe('e2e: idle', () => {
  test('10 minutes past last activity → {cur:0, all:0} and "⭐️ 0t/s"', async () => {
    const idleNow = NOW + 10 * 60 * 1000;
    const entries = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', idleNow);
    const rates = computeRate(entries, idleNow, config.windowSec * 1000);
    expect(rates).toEqual({ cur: 0, all: 0 });

    const { formatSpeed } = await import('../src/format');
    expect(formatSpeed(rates, config.effectiveRate)).toBe('⭐️ 0t/s');
  });
});
