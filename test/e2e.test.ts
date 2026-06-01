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
// Fixtures under test/fixtures/projects/:
//   enc-cur/sessCUR.jsonl                       (current session, main transcript)
//     · msg_out_of_window  @ 11:59:00Z  100000 tok  → BEFORE winStart → EXCLUDED
//     · msg_cur_A          @ 12:01:00Z    3000 tok  → in window, current  (×3 dup rows)
//   enc-cur/sessCUR/subagents/agent-x.jsonl     (current session, subagent)
//     · msg_cur_C_subagent @ 12:00:30Z    3000 tok  → in window, current
//   enc-other/sessOTHER.jsonl                   (a DIFFERENT session)
//     · msg_other_D        @ 12:01:30Z    6000 tok  → in window, NON-current
//
// Rate arithmetic (windowSec = 120):
//   cur sum = A(3000) + C(3000)            = 6000  →  6000 / 120  = 50  t/s
//   all sum = A(3000) + C(3000) + D(6000)  = 12000 → 12000 / 120  = 100 t/s
//   (the triplicated A counts once via dedup; the 100000-tok B is out of window)
// ──────────────────────────────────────────────────────────────────────────

const NOW = 1_780_228_920_000;

// Resolve the fixtures projects dir relative to this test file.
const PROJECTS_DIR = new URL('./fixtures/projects', import.meta.url).pathname;
const CUR_TRANSCRIPT = `${PROJECTS_DIR}/enc-cur/sessCUR.jsonl`;

const config: Config = {
  quota: 125,
  windowSec: 120,
  cells: 10,
  lookbackMs: 120 * 1000 + 60_000,
  tailBytes: 1_048_576,
  projectsDir: PROJECTS_DIR,
};

describe('e2e: gatherEntries + computeRate', () => {
  test('cur from current main+subagent in window; all includes other session; dedup; out-of-window excluded', async () => {
    const entries = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);
    const rates = computeRate(entries, NOW, config.windowSec * 1000);
    expect(rates).toEqual({ cur: 50, all: 100 });
  });
});

describe('e2e: buildStatusline full render', () => {
  test('exact full rendered string with all segments present', async () => {
    const entries = await gatherEntries(config, CUR_TRANSCRIPT, 'sessCUR', NOW);

    const input: StatuslineInput = {
      model: { display_name: 'Opus 4.8 (1M context)', id: 'claude-opus-4-8[1m]' },
      effort: { level: 'xhigh' },
      transcript_path: CUR_TRANSCRIPT,
      session_id: 'sessCUR',
    };

    // Canned ccusage line → session=13.5, today=330, block=31.25, burn=$13.18/hr, timeLeft=2h 35m.
    const ccusageLine =
      '🤖 Opus 4.8 (1M context) | 💰 $13.50 session / $330.00 today / $31.25 block (2h 35m left) | 🔥 $13.18/hr | 🧠 1,000 (2%)';

    const actual = buildStatusline({ input, ccusageLine, entries, now: NOW, config });

    // Build the expected string from the same pure helpers (block=31.25 → pct=75 → green).
    const pct = 75; // round((125 - 31.25) / 125 * 100) = round(75) = 75
    const quotaColored = truecolor(`${pct}% left ${renderBar(pct, 10)}`, quotaRgb(pct));
    const expected =
      '🤖 Opus 4.8-1m (ultracode)' +
      ' | 🔥 $13.18/hr' +
      ' | ⭐️ {50}100t/s' +
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
    expect(formatSpeed(rates)).toBe('⭐️ 0t/s');
  });
});
