import { describe, expect, test } from 'bun:test';

import {
  ccusageLane,
  fiveHourLane,
  formatModel,
  formatQuotaSegment,
  formatResetDuration,
  formatSpeed,
  formatWeeklyDuration,
  quotaRgb,
  renderBar,
  sevenDayLane,
  truecolor,
} from '../src/format';

describe('formatModel', () => {
  test('display name with 1M context + xhigh → ultracode', () => {
    expect(formatModel('Opus 4.8 (1M context)', 'claude-opus-4-8[1m]', 'xhigh')).toBe(
      '🤖 Opus 4.8-1m (ultracode)',
    );
  });

  test('high effort passes through', () => {
    expect(formatModel('Opus 4.8 (1M context)', 'claude-opus-4-8[1m]', 'high')).toBe(
      '🤖 Opus 4.8-1m (high)',
    );
  });

  test('undefined effort omits the suffix', () => {
    expect(formatModel('Opus 4.8 (1M context)', 'claude-opus-4-8[1m]', undefined)).toBe(
      '🤖 Opus 4.8-1m',
    );
  });

  test('falls back to modelId when displayName is undefined', () => {
    expect(formatModel(undefined, 'claude-x', undefined)).toBe('🤖 claude-x');
  });

  test('falls back to ? when both name sources are undefined', () => {
    expect(formatModel(undefined, undefined, undefined)).toBe('🤖 ?');
  });
});

describe('formatSpeed', () => {
  const NONE = { sessions: 0, subagents: 0 };

  test('idle → suffix always shown as 0[0] (never blinks out)', () => {
    expect(formatSpeed({ cur: 0, all: 0 }, NONE, true)).toBe('⭐️ 0t/s 0[0]');
  });

  test('collapses when cur === all (5/5) and appends the live counts', () => {
    expect(formatSpeed({ cur: 5, all: 5 }, { sessions: 1, subagents: 0 }, true)).toBe('⭐️ 5t/s 1[0]');
  });

  test('uses braces when cur !== all and appends the counts (the canonical example)', () => {
    expect(formatSpeed({ cur: 100, all: 5470 }, { sessions: 5, subagents: 10 }, true)).toBe(
      '⭐️ {100}5470t/s 5[10]',
    );
  });

  test('solo work with a sub-agent → 1[1]', () => {
    expect(formatSpeed({ cur: 5, all: 5 }, { sessions: 1, subagents: 1 }, true)).toBe('⭐️ 5t/s 1[1]');
  });

  test('counts are decoupled from the rate: live agents show even when the rate rounds to 0', () => {
    // The counts track file mtimes, not throughput — so a just-touched session
    // still shows while its per-second rate rounds down to 0 (the point of the split).
    expect(formatSpeed({ cur: 0, all: 0 }, { sessions: 2, subagents: 3 }, true)).toBe('⭐️ 0t/s 2[3]');
  });

  test('the suffix is unconditional — a busy rate with nothing live still reads 0[0]', () => {
    expect(formatSpeed({ cur: 300, all: 300 }, NONE, true)).toBe('⭐️ 300t/s 0[0]');
  });

  test('raw mode (effectiveRate=false) uses 🌟 instead of ⭐️', () => {
    expect(formatSpeed({ cur: 0, all: 0 }, NONE, false)).toBe('🌟 0t/s 0[0]');
    expect(formatSpeed({ cur: 50, all: 300 }, { sessions: 5, subagents: 10 }, false)).toBe(
      '🌟 {50}300t/s 5[10]',
    );
  });
});

describe('renderBar', () => {
  test('pct=0 → empty', () => {
    expect(renderBar(0, 10)).toBe('▱▱▱▱▱▱▱▱▱▱');
  });

  test('pct=55 → floor(5.5)=5 filled', () => {
    expect(renderBar(55, 10)).toBe('▰▰▰▰▰▱▱▱▱▱');
  });

  test('pct=75 → 7 filled', () => {
    expect(renderBar(75, 10)).toBe('▰▰▰▰▰▰▰▱▱▱');
  });

  test('pct=100 → full', () => {
    expect(renderBar(100, 10)).toBe('▰▰▰▰▰▰▰▰▰▰');
  });

  test('clamps over 100 to full (no negative repeat)', () => {
    expect(renderBar(150, 10)).toBe('▰▰▰▰▰▰▰▰▰▰');
  });

  test('clamps below 0 to empty', () => {
    expect(renderBar(-50, 10)).toBe('▱▱▱▱▱▱▱▱▱▱');
  });
});

describe('quotaRgb', () => {
  test('19 → red (below 20 boundary)', () => {
    expect(quotaRgb(19)).toEqual([255, 85, 85]);
  });

  test('20 → amber (at 20 boundary)', () => {
    expect(quotaRgb(20)).toEqual([240, 190, 70]);
  });

  test('49 → amber (below 50 boundary)', () => {
    expect(quotaRgb(49)).toEqual([240, 190, 70]);
  });

  test('50 → green (at 50 boundary)', () => {
    expect(quotaRgb(50)).toEqual([90, 205, 115]);
  });

  test('100 → green', () => {
    expect(quotaRgb(100)).toEqual([90, 205, 115]);
  });
});

describe('truecolor', () => {
  test('exact escape sequence', () => {
    expect(truecolor('hi', [10, 20, 30])).toBe('\x1b[38;2;10;20;30mhi\x1b[0m');
  });
});

describe('formatResetDuration', () => {
  test('hours + minutes', () => {
    expect(formatResetDuration((2 * 3600 + 35 * 60) * 1000)).toBe('2h 35m');
  });

  test('whole hours keep the 0m part (matches ccusage style)', () => {
    expect(formatResetDuration(3600 * 1000)).toBe('1h 0m');
  });

  test('minutes only when under an hour', () => {
    expect(formatResetDuration(45 * 60 * 1000)).toBe('45m');
  });

  test('partial minutes floor to the minute', () => {
    expect(formatResetDuration(59 * 1000)).toBe('0m');
  });

  test('zero and negative clamp to 0m', () => {
    expect(formatResetDuration(0)).toBe('0m');
    expect(formatResetDuration(-5000)).toBe('0m');
  });
});

describe('formatWeeklyDuration', () => {
  test('days + hours', () => {
    expect(formatWeeklyDuration((3 * 24 + 2) * 3600 * 1000)).toBe('3d 2h');
  });

  test('whole days keep the 0h part', () => {
    expect(formatWeeklyDuration(3 * 24 * 3600 * 1000)).toBe('3d 0h');
  });

  test('hours only when under a day', () => {
    expect(formatWeeklyDuration(5 * 3600 * 1000)).toBe('5h');
  });

  test('partial hours floor to the hour', () => {
    expect(formatWeeklyDuration((2 * 3600 + 59 * 60) * 1000)).toBe('2h');
  });

  test('under an hour → 0h (weekly window never shows minutes)', () => {
    expect(formatWeeklyDuration(45 * 60 * 1000)).toBe('0h');
  });

  test('zero and negative clamp to 0h', () => {
    expect(formatWeeklyDuration(0)).toBe('0h');
    expect(formatWeeklyDuration(-5000)).toBe('0h');
  });
});

describe('fiveHourLane', () => {
  // NOW in ms; resets_at is Unix epoch SECONDS (Claude Code rate_limits shape).
  const NOW = 1_780_228_920_000;

  test('remaining pct (round(100 - used)) + minute-precision time', () => {
    // used 23.5 → 76.5 → 77; resets in 2h 35m.
    const resetsAt = NOW / 1000 + 2 * 3600 + 35 * 60;
    expect(fiveHourLane(23.5, resetsAt, NOW)).toEqual({ pct: 77, timeLeft: '2h 35m' });
  });

  test('clamps over-100 used to 0%; past reset → 0m', () => {
    expect(fiveHourLane(130, NOW / 1000 - 60, NOW)).toEqual({ pct: 0, timeLeft: '0m' });
  });
});

describe('sevenDayLane', () => {
  const NOW = 1_780_228_920_000;

  test('remaining pct + day/hour time (no minutes)', () => {
    // used 80 → 20; resets in 3d 2h.
    const resetsAt = NOW / 1000 + (3 * 24 + 2) * 3600;
    expect(sevenDayLane(80, resetsAt, NOW)).toEqual({ pct: 20, timeLeft: '3d 2h' });
  });

  test('under a day shows hours only', () => {
    expect(sevenDayLane(55, NOW / 1000 + 5 * 3600, NOW)).toEqual({ pct: 45, timeLeft: '5h' });
  });
});

describe('ccusageLane', () => {
  test('pct = round((quota - block)/quota*100); timeLeft passes through', () => {
    // quota 125, block 31.25 → 75.
    expect(ccusageLane('2h 35m', 31.25, 125)).toEqual({ pct: 75, timeLeft: '2h 35m' });
  });

  test('clamps to 0 when over-spent', () => {
    expect(ccusageLane('0m', 200, 125)).toEqual({ pct: 0, timeLeft: '0m' });
  });
});

describe('formatQuotaSegment', () => {
  const fh = { pct: 60, timeLeft: '1h 5m' };
  const wd = { pct: 20, timeLeft: '3d 2h' };

  test('both lanes → "<5h piece> <7d piece>", each a solid bar, space-separated', () => {
    const fhPiece = `1h 5m ${truecolor(`60% ${renderBar(60, 10)}`, quotaRgb(60))}`;
    const wdPiece = `3d 2h ${truecolor(`20% ${renderBar(20, 10)}`, quotaRgb(20))}`;
    expect(formatQuotaSegment(fh, wd, 10)).toBe(`⚡ ${fhPiece} ${wdPiece}`);
  });

  test('only 5-hour lane → plain labelled bar', () => {
    const colored = truecolor(`60% ${renderBar(60, 10)}`, quotaRgb(60));
    expect(formatQuotaSegment(fh, null, 10)).toBe(`⚡ 1h 5m ${colored}`);
  });

  test('only weekly lane → plain labelled bar', () => {
    const colored = truecolor(`20% ${renderBar(20, 10)}`, quotaRgb(20));
    expect(formatQuotaSegment(null, wd, 10)).toBe(`⚡ 3d 2h ${colored}`);
  });

  test('no lanes → empty string (caller omits the ⚡ segment)', () => {
    expect(formatQuotaSegment(null, null, 10)).toBe('');
  });
});

describe('formatQuotaSegment — percentage scaling (10% per cell)', () => {
  test('default 10-cell bar counts from 100% (unchanged)', () => {
    const colored = truecolor(`60% ${renderBar(60, 10)}`, quotaRgb(60));
    expect(formatQuotaSegment({ pct: 60, timeLeft: '1h' }, null, 10)).toBe(`⚡ 1h ${colored}`);
  });

  test('40-cell bar (Max 20x / max mode) counts from 400% at full', () => {
    // pct=100 remaining → shown 400%, all 40 cells filled, green.
    const colored = truecolor(`400% ${renderBar(100, 40)}`, quotaRgb(100));
    expect(formatQuotaSegment({ pct: 100, timeLeft: '4h' }, null, 40)).toBe(`⚡ 4h ${colored}`);
  });

  test('the number scales, but colour + fill stay keyed on the true fraction (low = red)', () => {
    // pct=15 (85% used) → shown 60%, yet RED (15 < 20) with only 6/40 cells filled.
    const colored = truecolor(`60% ${renderBar(15, 40)}`, quotaRgb(15));
    expect(formatQuotaSegment({ pct: 15, timeLeft: '10m' }, null, 40)).toBe(`⚡ 10m ${colored}`);
    expect(quotaRgb(15)).toEqual([255, 85, 85]); // guard: still red, not softened by the 60% display
  });

  test('half-remaining on a 40-cell bar → 200%, 20 cells', () => {
    const colored = truecolor(`200% ${renderBar(50, 40)}`, quotaRgb(50));
    expect(formatQuotaSegment({ pct: 50, timeLeft: '2h' }, null, 40)).toBe(`⚡ 2h ${colored}`);
  });
});
