import { describe, expect, test } from 'bun:test';

import {
  formatModel,
  formatQuota,
  formatRateLimitQuota,
  formatResetDuration,
  formatSpeed,
  quotaRgb,
  renderBar,
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
  test('collapses to single value when cur === all (idle 0/0)', () => {
    expect(formatSpeed({ cur: 0, all: 0 }, true)).toBe('⭐️ 0t/s');
  });

  test('collapses when cur === all (5/5)', () => {
    expect(formatSpeed({ cur: 5, all: 5 }, true)).toBe('⭐️ 5t/s');
  });

  test('uses braces when cur !== all', () => {
    expect(formatSpeed({ cur: 50, all: 300 }, true)).toBe('⭐️ {50}300t/s');
  });

  test('raw mode (effectiveRate=false) uses 🌟 instead of ⭐️', () => {
    expect(formatSpeed({ cur: 0, all: 0 }, false)).toBe('🌟 0t/s');
    expect(formatSpeed({ cur: 50, all: 300 }, false)).toBe('🌟 {50}300t/s');
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

describe('formatRateLimitQuota', () => {
  // NOW in ms; resets_at is Unix epoch SECONDS (Claude Code rate_limits shape).
  const NOW = 1_780_228_920_000;

  test('renders time-to-reset + colored "<pct>% left <bar>" from used_percentage', () => {
    // used 23.5% → pct = round(76.5) = 77 → green; resets in 2h 35m.
    const resetsAt = NOW / 1000 + 2 * 3600 + 35 * 60;
    const pct = 77;
    const colored = truecolor(`${pct}% left ${renderBar(pct, 10)}`, quotaRgb(pct));
    expect(formatRateLimitQuota(23.5, resetsAt, NOW, 10)).toBe(`⚡ 2h 35m, ${colored}`);
  });

  test('clamps used_percentage over 100 to 0% left (red)', () => {
    const resetsAt = NOW / 1000 + 600;
    const colored = truecolor(`0% left ${renderBar(0, 10)}`, quotaRgb(0));
    expect(formatRateLimitQuota(130, resetsAt, NOW, 10)).toBe(`⚡ 10m, ${colored}`);
  });

  test('used 0% → 100% left, past reset time → 0m', () => {
    const colored = truecolor(`100% left ${renderBar(100, 10)}`, quotaRgb(100));
    expect(formatRateLimitQuota(0, NOW / 1000 - 60, NOW, 10)).toBe(`⚡ 0m, ${colored}`);
  });
});

describe('formatQuota', () => {
  test('assembles "⚡ <t>, " + colored "<pct>% left <bar>"', () => {
    // quota=125, blockCost=31.25 → pct = round(75%) = 75 → green
    const pct = 75;
    const bar = renderBar(pct, 10);
    const colored = truecolor(`${pct}% left ${bar}`, quotaRgb(pct));
    expect(formatQuota('2h 35m', 31.25, 125, 10)).toBe(`⚡ 2h 35m, ${colored}`);
  });

  test('clamps pct to [0,100] when over-spent', () => {
    // blockCost > quota → raw pct negative → clamps to 0 → red
    const colored = truecolor(`0% left ${renderBar(0, 10)}`, quotaRgb(0));
    expect(formatQuota('0m', 200, 125, 10)).toBe(`⚡ 0m, ${colored}`);
  });
});
