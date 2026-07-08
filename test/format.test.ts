import { describe, expect, test } from 'bun:test';

import {
  ccusageLane,
  DIM,
  dimColor,
  fiveHourLane,
  formatModel,
  formatQuotaSegment,
  formatResetDuration,
  formatSpeed,
  formatWeeklyDuration,
  layerColor,
  quotaRgb,
  renderBar,
  sevenDayLane,
  truecolor,
} from '../src/format';

// Aurora RGB constants for the fighting-game layered bar, pinned by the `layerColor` spec below.
const CYAN: [number, number, number] = [34, 211, 238]; // surplus layer 2 (first above base)
const BLUE: [number, number, number] = [96, 165, 250]; // surplus layer 3
const VIOLET: [number, number, number] = [167, 139, 250]; // surplus layer 4 (top of a Max 20x stack)
const GREEN: [number, number, number] = [52, 211, 153]; // emerald base at full (quotaRgb ≥ 50)
const AMBER: [number, number, number] = [244, 168, 54]; // base warning (quotaRgb 20–49)
const RED: [number, number, number] = [239, 68, 68]; // base danger (quotaRgb < 20)

/**
 * Expected rendered lane, built from the trusted primitives (`layerColor`/`dimColor`/`DIM` are
 * pinned to literals in their own specs). Mirrors `renderLane`: the FULL stacked bar, `cells ×
 * layers` wide, one `cells`-wide zone per layer. `filled = floor((pct/100) × totalCells)` cells
 * are fully held in their zone colour; the single cell at `filled` is the dim FRONTIER; every
 * cell past it is the neutral gray `DIM` consumed track. The base zone runs the danger gradient
 * on its own remaining % (`min(displayPct, 100)`). %-label = displayPct in the top-most layer's
 * colour. Adjacent same-colour cells coalesce into one run.
 */
const lane = (pct: number, timeLeft: string, cells: number, layers: number): string => {
  const totalCells = cells * layers;
  const displayPct = pct * layers;
  const baseRemaining = Math.max(0, Math.min(100, displayPct));
  const filled = Math.min(Math.max(Math.floor((pct / 100) * totalCells), 0), totalCells);
  const cellRgb = (i: number): [number, number, number] => {
    const zone = layerColor(Math.floor(i / cells) + 1, baseRemaining);
    return i < filled ? zone : i === filled ? dimColor(zone) : DIM;
  };
  let bar = '';
  for (let i = 0; i < totalCells; ) {
    const rgb = cellRgb(i);
    let j = i + 1;
    while (j < totalCells && cellRgb(j).every((c, k) => c === rgb[k])) j++;
    bar += truecolor('▰'.repeat(j - i), rgb);
    i = j;
  }
  const current = Math.min(Math.max(Math.ceil(displayPct / 100), 1), layers);
  return `${timeLeft} ${truecolor(`${Math.round(displayPct)}%`, layerColor(current, baseRemaining))} ${bar}`;
};

describe('formatModel', () => {
  test('display name with 1M context + xhigh → ultracode', () => {
    expect(formatModel('Opus 4.8 (1M context)', 'claude-opus-4-8[1m]', 'xhigh')).toBe(
      '🥷 Opus 4.8-1m (ultracode)',
    );
  });

  test('high effort passes through', () => {
    expect(formatModel('Opus 4.8 (1M context)', 'claude-opus-4-8[1m]', 'high')).toBe(
      '🥷 Opus 4.8-1m (high)',
    );
  });

  test('undefined effort omits the suffix', () => {
    expect(formatModel('Opus 4.8 (1M context)', 'claude-opus-4-8[1m]', undefined)).toBe(
      '🥷 Opus 4.8-1m',
    );
  });

  test('falls back to modelId when displayName is undefined (unknown model → default 🤖)', () => {
    expect(formatModel(undefined, 'claude-x', undefined)).toBe('🤖 claude-x');
  });

  test('falls back to ? when both name sources are undefined', () => {
    expect(formatModel(undefined, undefined, undefined)).toBe('🤖 ?');
  });
});

describe('formatModel — per-model emoji', () => {
  test('Fable → 🐉 dragon', () => {
    expect(formatModel('Fable 5', 'claude-fable-5', 'xhigh')).toBe('🐉 Fable 5 (ultracode)');
  });

  test('Opus → 🥷 ninja', () => {
    expect(formatModel('Opus 4.8 (1M context)', 'claude-opus-4-8[1m]', 'high')).toBe(
      '🥷 Opus 4.8-1m (high)',
    );
  });

  test('Sonnet → 🐱 cat', () => {
    expect(formatModel('Sonnet 5', 'claude-sonnet-5', undefined)).toBe('🐱 Sonnet 5');
  });

  test('Haiku and other models keep the default 🤖', () => {
    expect(formatModel('Haiku 4.5', 'claude-haiku-4-5-20251001', 'high')).toBe('🤖 Haiku 4.5 (high)');
  });

  test('family is detected from the id even when the display name is absent', () => {
    expect(formatModel(undefined, 'claude-sonnet-5', undefined)).toBe('🐱 claude-sonnet-5');
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
    expect(quotaRgb(19)).toEqual([239, 68, 68]);
  });

  test('20 → amber (at 20 boundary)', () => {
    expect(quotaRgb(20)).toEqual([244, 168, 54]);
  });

  test('49 → amber (below 50 boundary)', () => {
    expect(quotaRgb(49)).toEqual([244, 168, 54]);
  });

  test('50 → emerald (at 50 boundary)', () => {
    expect(quotaRgb(50)).toEqual([52, 211, 153]);
  });

  test('100 → emerald', () => {
    expect(quotaRgb(100)).toEqual([52, 211, 153]);
  });
});

describe('layerColor', () => {
  test('base layer (n=1) runs the danger gradient on its own remaining %', () => {
    expect(layerColor(1, 100)).toEqual([52, 211, 153]); // full base → emerald
    expect(layerColor(1, 45)).toEqual([244, 168, 54]); // amber
    expect(layerColor(1, 10)).toEqual([239, 68, 68]); // nearly-empty reserve → red warning
  });

  test('n ≤ 0 is treated as the base too (defensive)', () => {
    expect(layerColor(0, 100)).toEqual([52, 211, 153]);
  });

  test('surplus layers are static Aurora identity colours (base % ignored)', () => {
    expect(layerColor(2, 5)).toEqual([34, 211, 238]); // cyan — first above base
    expect(layerColor(3, 5)).toEqual([96, 165, 250]); // blue
    expect(layerColor(4, 5)).toEqual([167, 139, 250]); // violet — top of a Max 20x stack
  });

  test('a layer deeper than the palette clamps to the top colour', () => {
    expect(layerColor(5, 100)).toEqual([167, 139, 250]);
    expect(layerColor(9, 100)).toEqual([167, 139, 250]);
  });
});

describe('dimColor', () => {
  const luma = ([r, g, b]: number[]): number => 0.299 * r + 0.587 * g + 0.114 * b;

  test('desaturates then darkens (the dimmed frontier shade)', () => {
    expect(dimColor([52, 211, 153])).toEqual([53, 115, 93]); // emerald frontier
    expect(dimColor([96, 165, 250])).toEqual([70, 97, 130]); // blue frontier
  });

  test('always darker than its source, so the frontier reads below the bright held fill', () => {
    for (const c of [CYAN, BLUE, VIOLET, GREEN] as [number, number, number][]) {
      expect(luma(dimColor(c))).toBeLessThan(luma(c));
    }
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

describe('formatQuotaSegment — composition (1-layer plan)', () => {
  const fh = { pct: 60, timeLeft: '1h 5m' };
  const wd = { pct: 20, timeLeft: '3d 2h' };

  test('both lanes → "<5h piece> <7d piece>", each a bar, space-separated', () => {
    expect(formatQuotaSegment(fh, wd, 10, 1)).toBe(`⚡ ${lane(60, '1h 5m', 10, 1)} ${lane(20, '3d 2h', 10, 1)}`);
  });

  test('only 5-hour lane → single labelled bar', () => {
    expect(formatQuotaSegment(fh, null, 10, 1)).toBe(`⚡ ${lane(60, '1h 5m', 10, 1)}`);
  });

  test('only weekly lane → single labelled bar', () => {
    expect(formatQuotaSegment(null, wd, 10, 1)).toBe(`⚡ ${lane(20, '3d 2h', 10, 1)}`);
  });

  test('no lanes → empty string (caller omits the ⚡ segment)', () => {
    expect(formatQuotaSegment(null, null, 10, 1)).toBe('');
  });
});

describe('formatQuotaSegment — fighting-game layered bar', () => {
  // ── 1-layer plan (Pro / 5x): a single emerald→amber→red bar, solid held cells, dim frontier ──
  test('1 layer, byte-exact: pct 60 → 6 emerald solid + 1 dim frontier + 3 gray', () => {
    // floor(0.6·10)=6 fully held; the 7th is being consumed (dim emerald); 3 gray remain.
    const expected =
      `1h ${truecolor('60%', GREEN)} ` +
      `${truecolor('▰▰▰▰▰▰', GREEN)}${truecolor('▰', dimColor(GREEN))}${truecolor('▰▰▰', DIM)}`;
    expect(formatQuotaSegment({ pct: 60, timeLeft: '1h' }, null, 10, 1)).toBe(`⚡ ${expected}`);
  });

  test('1 layer: low quota still fires the red warning at <20% (pct 12 → 1 red solid + dim frontier)', () => {
    // floor(0.12·10)=1 held (red); the 2nd is being consumed (dim red); 8 gray.
    const expected =
      `10m ${truecolor('12%', RED)} ${truecolor('▰', RED)}${truecolor('▰', dimColor(RED))}${truecolor('▰▰▰▰▰▰▰▰', DIM)}`;
    expect(formatQuotaSegment({ pct: 12, timeLeft: '10m' }, null, 10, 1)).toBe(`⚡ ${expected}`);
  });

  // ── 4-layer plan (Max 20x): the FULL stacked bar, cells × layers wide, all zones on screen ──
  // (These use cells=10 → 40-cell bars for readable literals; the 80-cell default is covered below.)
  test('4 layers, byte-exact: full → 400%, all four zones solid (emerald|cyan|blue|violet), no frontier', () => {
    // filled 40 → every cell held; four 10-cell zones, no frontier, no gray.
    const expected =
      `4h ${truecolor('400%', VIOLET)} ` +
      `${truecolor('▰'.repeat(10), GREEN)}${truecolor('▰'.repeat(10), CYAN)}${truecolor('▰'.repeat(10), BLUE)}${truecolor('▰'.repeat(10), VIOLET)}`;
    expect(formatQuotaSegment({ pct: 100, timeLeft: '4h' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  test('4 layers: mid-top-layer → 350%, three zones full + 5 violet + dim-violet frontier + gray', () => {
    // pct 87.5 → filled 35: base|cyan|blue full (30), 5 violet held, frontier at 35 (dim violet), 4 gray.
    const expected =
      `4h ${truecolor('350%', VIOLET)} ` +
      `${truecolor('▰'.repeat(10), GREEN)}${truecolor('▰'.repeat(10), CYAN)}${truecolor('▰'.repeat(10), BLUE)}` +
      `${truecolor('▰'.repeat(5), VIOLET)}${truecolor('▰', dimColor(VIOLET))}${truecolor('▰'.repeat(4), DIM)}`;
    expect(formatQuotaSegment({ pct: 87.5, timeLeft: '4h' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  test('4 layers: exactly 300% → base|cyan|blue full, dim frontier at the violet-zone edge, gray tail', () => {
    // pct 75 → filled 30 (exact layer boundary). The frontier sits at index 30, the first violet cell,
    // so it's a dim-violet marker; the %-label takes the top FULL layer (blue) — the one boundary case
    // where label colour (blue) and frontier zone (violet) differ. 9 gray follow.
    const expected =
      `4h ${truecolor('300%', BLUE)} ` +
      `${truecolor('▰'.repeat(10), GREEN)}${truecolor('▰'.repeat(10), CYAN)}${truecolor('▰'.repeat(10), BLUE)}` +
      `${truecolor('▰', dimColor(VIOLET))}${truecolor('▰'.repeat(9), DIM)}`;
    expect(formatQuotaSegment({ pct: 75, timeLeft: '4h' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  test('4 layers: into surplus → 200%, base + cyan full, dim-blue frontier, gray; base still emerald', () => {
    // pct 50 → filled 20. baseRemaining = min(200,100) = 100 → base emerald (surplus present = safe).
    const expected =
      `4h ${truecolor('200%', CYAN)} ` +
      `${truecolor('▰'.repeat(10), GREEN)}${truecolor('▰'.repeat(10), CYAN)}` +
      `${truecolor('▰', dimColor(BLUE))}${truecolor('▰'.repeat(19), DIM)}`;
    expect(formatQuotaSegment({ pct: 50, timeLeft: '4h' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  test('4 layers: down into the base reserve → 100%, base full (emerald), dim-cyan frontier, gray', () => {
    // pct 25 → filled 10 → whole base held; frontier at index 10 (first cyan cell); 29 gray.
    const expected =
      `4h ${truecolor('100%', GREEN)} ${truecolor('▰'.repeat(10), GREEN)}${truecolor('▰', dimColor(CYAN))}${truecolor('▰'.repeat(29), DIM)}`;
    expect(formatQuotaSegment({ pct: 25, timeLeft: '4h' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  test('4 layers: base half-spent → 40%, amber held cells + dim-amber frontier fire the warning', () => {
    // pct 10 → displayPct 40 → baseRemaining 40 → amber. filled 4 amber, dim-amber frontier, 35 gray.
    const expected =
      `3h ${truecolor('40%', AMBER)} ${truecolor('▰'.repeat(4), AMBER)}${truecolor('▰', dimColor(AMBER))}${truecolor('▰'.repeat(35), DIM)}`;
    expect(formatQuotaSegment({ pct: 10, timeLeft: '3h' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  test('4 layers: nearly-exhausted base → a lone dim-red frontier over the gray track', () => {
    // pct 2 → displayPct 8 → baseRemaining 8 → red; filled 0 → lone dim-red frontier, 39 gray.
    const expected = `1m ${truecolor('8%', RED)} ${truecolor('▰', dimColor(RED))}${truecolor('▰'.repeat(39), DIM)}`;
    expect(formatQuotaSegment({ pct: 2, timeLeft: '1m' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  test('4 layers: at 0% → a lone dim-red frontier (the cell being consumed) over 39 gray', () => {
    const expected = `0m ${truecolor('0%', RED)} ${truecolor('▰', dimColor(RED))}${truecolor('▰'.repeat(39), DIM)}`;
    expect(formatQuotaSegment({ pct: 0, timeLeft: '0m' }, null, 10, 4)).toBe(`⚡ ${expected}`);
  });

  // ── the 80-cell default (cells=20, layers=4): what a Max 20x plan actually shows ──
  test('80 cells, byte-exact: full 400% → four 20-cell zones, no frontier', () => {
    const expected =
      `4h ${truecolor('400%', VIOLET)} ` +
      `${truecolor('▰'.repeat(20), GREEN)}${truecolor('▰'.repeat(20), CYAN)}${truecolor('▰'.repeat(20), BLUE)}${truecolor('▰'.repeat(20), VIOLET)}`;
    expect(formatQuotaSegment({ pct: 100, timeLeft: '4h' }, null, 20, 4)).toBe(`⚡ ${expected}`);
  });

  test('80 cells: 200% → base + cyan full (40), dim-blue frontier, 39 gray', () => {
    // pct 50 → filled 40; base emerald (baseRemaining 100), cyan full, frontier at first blue cell.
    const expected =
      `4h ${truecolor('200%', CYAN)} ` +
      `${truecolor('▰'.repeat(20), GREEN)}${truecolor('▰'.repeat(20), CYAN)}${truecolor('▰', dimColor(BLUE))}${truecolor('▰'.repeat(39), DIM)}`;
    expect(formatQuotaSegment({ pct: 50, timeLeft: '4h' }, null, 20, 4)).toBe(`⚡ ${expected}`);
  });

  test('bar width is exactly cells × layers (the full stacked bar)', () => {
    const glyphs = (s: string): number => (s.match(/▰/g) ?? []).length;
    expect(glyphs(formatQuotaSegment({ pct: 50, timeLeft: 't' }, null, 10, 1))).toBe(10);
    expect(glyphs(formatQuotaSegment({ pct: 50, timeLeft: 't' }, null, 20, 1))).toBe(20);
    expect(glyphs(formatQuotaSegment({ pct: 50, timeLeft: 't' }, null, 10, 4))).toBe(40);
    expect(glyphs(formatQuotaSegment({ pct: 50, timeLeft: 't' }, null, 20, 4))).toBe(80); // Max 20x
  });

  test('renderer and helper agree across the descent for 1- and 4-layer bars', () => {
    for (const [cells, layers] of [
      [10, 4],
      [20, 4],
      [20, 1],
    ] as [number, number][]) {
      for (const pct of [100, 90, 87.5, 75, 62.5, 50, 37.5, 25, 15, 8, 2, 0]) {
        expect(formatQuotaSegment({ pct, timeLeft: 't' }, null, cells, layers)).toBe(
          `⚡ ${lane(pct, 't', cells, layers)}`,
        );
      }
    }
  });
});
