import { describe, expect, test } from 'bun:test';

import { parseConfig } from '../src/config';

const HOME = '/home/tester';

describe('parseConfig — defaults', () => {
  test('empty env yields the documented defaults', () => {
    const c = parseConfig({ HOME });
    expect(c).toEqual({
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
      projectsDir: `${HOME}/.claude/projects`,
    });
  });
});

describe('parseConfig — num()', () => {
  test('valid positive overrides win', () => {
    const c = parseConfig({ HOME, CCSS_QUOTA: '200', CCSS_WINDOW: '180', CCSS_CCUSAGE_REFRESH: '60' });
    expect(c.quota).toBe(200);
    expect(c.windowSec).toBe(180);
    expect(c.ccusageRefreshSec).toBe(60);
  });

  test('zero, negative, blank, and non-numeric fall back', () => {
    expect(parseConfig({ HOME, CCSS_WINDOW: '0' }).windowSec).toBe(120);
    expect(parseConfig({ HOME, CCSS_WINDOW: '-5' }).windowSec).toBe(120);
    expect(parseConfig({ HOME, CCSS_WINDOW: '' }).windowSec).toBe(120);
    expect(parseConfig({ HOME, CCSS_WINDOW: '   ' }).windowSec).toBe(120);
    expect(parseConfig({ HOME, CCSS_WINDOW: 'abc' }).windowSec).toBe(120);
  });

  test('lookbackMs tracks the larger of window / active window', () => {
    // Active window larger than the rate window drives the lookback.
    const c = parseConfig({ HOME, CCSS_WINDOW: '30', CCSS_ACTIVE_WINDOW: '300' });
    expect(c.lookbackMs).toBe(300 * 1000 + 60_000);
  });
});

describe('parseConfig — cells / plan bar scale', () => {
  test('default is 10 cells (baseline scale)', () => {
    expect(parseConfig({ HOME }).cells).toBe(10);
  });

  test('barScale scales the default (Max 20x → 4× → 40 cells)', () => {
    expect(parseConfig({ HOME }, 4).cells).toBe(40);
    expect(parseConfig({ HOME }, 1).cells).toBe(10);
  });

  test('explicit CCSS_CELLS always wins over the plan scale', () => {
    expect(parseConfig({ HOME, CCSS_CELLS: '25' }, 4).cells).toBe(25);
    expect(parseConfig({ HOME, CCSS_CELLS: '80' }).cells).toBe(80);
  });

  test('invalid CCSS_CELLS (zero / non-numeric) falls back to the scaled default', () => {
    expect(parseConfig({ HOME, CCSS_CELLS: '0' }, 4).cells).toBe(40);
    expect(parseConfig({ HOME, CCSS_CELLS: 'abc' }, 4).cells).toBe(40);
  });
});

describe('parseConfig — bool()', () => {
  test('falsy words (any case) turn a default-on flag off', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off', ' no ']) {
      expect(parseConfig({ HOME, CCSS_CACHE: v }).includeCache).toBe(false);
    }
  });

  test('truthy values turn a default-off flag on', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
      expect(parseConfig({ HOME, CCSS_WEEKLY: v }).showWeekly).toBe(true);
    }
  });

  test('unset OR blank reads as "use the default" — the bool("") bug guard', () => {
    // A default-off flag must stay off when the var is exported-but-empty.
    expect(parseConfig({ HOME }).showWeekly).toBe(false);
    expect(parseConfig({ HOME, CCSS_WEEKLY: '' }).showWeekly).toBe(false);
    expect(parseConfig({ HOME, CCSS_WEEKLY: '   ' }).showWeekly).toBe(false);
    // A default-on flag likewise stays on when blank.
    expect(parseConfig({ HOME, CCSS_EFFECTIVE: '' }).effectiveRate).toBe(true);
  });
});
