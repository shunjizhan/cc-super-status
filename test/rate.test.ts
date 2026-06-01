import { describe, expect, test } from 'bun:test';

import type { TokenEntry } from '../src/types';
import { computeRate } from '../src/rate';

// Helper: build a TokenEntry with sane defaults.
const entry = (over: Partial<TokenEntry> & Pick<TokenEntry, 'id' | 'tok' | 'ts'>): TokenEntry => ({
  current: false,
  ...over,
});

const NOW = 1_000_000;
const WINDOW = 120_000; // 120s → windowSec = 120

describe('computeRate', () => {
  test('empty input → {cur:0, all:0}', () => {
    expect(computeRate([], NOW, WINDOW)).toEqual({ cur: 0, all: 0 });
  });

  test('triplicate rows for same id are counted once', () => {
    // Three rows, same id, identical tok — should count as a single 120-token event.
    const entries = [
      entry({ id: 'a', tok: 120, ts: NOW, current: true }),
      entry({ id: 'a', tok: 120, ts: NOW, current: true }),
      entry({ id: 'a', tok: 120, ts: NOW, current: true }),
    ];
    // sum = 120 over 120s = 1 token/s (not 3).
    expect(computeRate(entries, NOW, WINDOW)).toEqual({ cur: 1, all: 1 });
  });

  test('dedup keeps max tok, max ts, OR of current within a group', () => {
    const entries = [
      entry({ id: 'a', tok: 60, ts: NOW - 10_000, current: false }),
      entry({ id: 'a', tok: 240, ts: NOW - 5_000, current: false }), // max tok=240, max ts=NOW-5000
      entry({ id: 'a', tok: 100, ts: NOW - 50_000, current: true }), // contributes current=true
    ];
    // One group: tok=240 → all = round(240/120) = 2; current is true → cur = 2.
    expect(computeRate(entries, NOW, WINDOW)).toEqual({ cur: 2, all: 2 });
  });

  test('idle: all ts older than end-windowMs → {cur:0, all:0}', () => {
    const entries = [
      entry({ id: 'a', tok: 5000, ts: NOW - WINDOW - 1, current: true }),
      entry({ id: 'b', tok: 5000, ts: NOW - 10 * WINDOW, current: false }),
    ];
    // end = max(NOW, maxTs) = NOW; winStart = NOW - WINDOW; both ts < winStart → nothing selected.
    expect(computeRate(entries, NOW, WINDOW)).toEqual({ cur: 0, all: 0 });
  });

  test('cur < all when some entries current and some not', () => {
    const entries = [
      entry({ id: 'cur1', tok: 120, ts: NOW, current: true }),
      entry({ id: 'cur2', tok: 120, ts: NOW - 1000, current: true }),
      entry({ id: 'other', tok: 240, ts: NOW - 2000, current: false }),
    ];
    // all = round((120+120+240)/120) = round(480/120) = 4
    // cur = round((120+120)/120) = round(240/120) = 2
    const rates = computeRate(entries, NOW, WINDOW);
    expect(rates).toEqual({ cur: 2, all: 4 });
    expect(rates.cur).toBeLessThan(rates.all);
  });

  test('window boundary is inclusive on both edges', () => {
    // end = NOW (no ts exceeds now). winStart = NOW - WINDOW.
    const entries = [
      entry({ id: 'start', tok: 120, ts: NOW - WINDOW, current: true }), // exactly winStart → included
      entry({ id: 'end', tok: 120, ts: NOW, current: false }), //              exactly end → included
      entry({ id: 'before', tok: 999, ts: NOW - WINDOW - 1, current: true }), // just outside → excluded
    ];
    // included: start(120,cur) + end(120) = all 240 → round(240/120)=2; cur 120 → 1.
    expect(computeRate(entries, NOW, WINDOW)).toEqual({ cur: 1, all: 2 });
  });

  test('end extends past now when a ts is in the future', () => {
    // A future ts pushes end forward, so winStart moves with it.
    const future = NOW + 30_000;
    const entries = [
      entry({ id: 'future', tok: 120, ts: future, current: true }),
      entry({ id: 'old', tok: 120, ts: NOW - WINDOW, current: false }), // now end-windowMs = future-WINDOW > this ts → excluded
    ];
    // end = future; winStart = future - WINDOW = NOW - 90_000. old.ts = NOW-120_000 < winStart → excluded.
    // only future selected: all = round(120/120)=1, cur=1.
    expect(computeRate(entries, NOW, WINDOW)).toEqual({ cur: 1, all: 1 });
  });

  test('rounds to nearest integer (half rounds up)', () => {
    // tok=60 over 120s = 0.5 → Math.round(0.5) = 1.
    const half = [entry({ id: 'a', tok: 60, ts: NOW, current: true })];
    expect(computeRate(half, NOW, WINDOW)).toEqual({ cur: 1, all: 1 });

    // tok=59 over 120s = 0.491... → rounds to 0.
    const down = [entry({ id: 'b', tok: 59, ts: NOW, current: false })];
    expect(computeRate(down, NOW, WINDOW)).toEqual({ cur: 0, all: 0 });

    // tok=90 over 120s = 0.75 → rounds to 1.
    const up = [entry({ id: 'c', tok: 90, ts: NOW, current: true })];
    expect(computeRate(up, NOW, WINDOW)).toEqual({ cur: 1, all: 1 });
  });

  test('no entries selected → {cur:0, all:0} even with non-current data present', () => {
    const entries = [entry({ id: 'a', tok: 1000, ts: NOW - WINDOW - 5000, current: false })];
    expect(computeRate(entries, NOW, WINDOW)).toEqual({ cur: 0, all: 0 });
  });

  test('non-positive / non-finite window → {cur:0, all:0} (guards CCSS_WINDOW=0)', () => {
    const entries = [entry({ id: 'a', tok: 5000, ts: NOW, current: true })];
    expect(computeRate(entries, NOW, 0)).toEqual({ cur: 0, all: 0 });
    expect(computeRate(entries, NOW, -1000)).toEqual({ cur: 0, all: 0 });
    expect(computeRate(entries, NOW, Number.NaN)).toEqual({ cur: 0, all: 0 });
  });
});
