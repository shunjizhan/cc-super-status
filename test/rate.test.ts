import { describe, expect, test } from 'bun:test';

import type { TokenEntry } from '../src/types';
import { computeRatesBySession } from '../src/rate';

// Helper: build a TokenEntry with a sane default session.
const entry = (over: Partial<TokenEntry> & Pick<TokenEntry, 'id' | 'tok' | 'ts'>): TokenEntry => ({
  session: 's',
  ...over,
});

const NOW = 1_000_000;
const WINDOW = 120_000; // 120s → windowSec = 120

describe('computeRatesBySession', () => {
  test('empty input → all 0, empty bySession', () => {
    expect(computeRatesBySession([], NOW, WINDOW)).toEqual({ all: 0, bySession: {} });
  });

  test('triplicate rows for same id are counted once', () => {
    // Three rows, same id, identical tok — a single 120-token event.
    const entries = [
      entry({ id: 'a', tok: 120, ts: NOW }),
      entry({ id: 'a', tok: 120, ts: NOW }),
      entry({ id: 'a', tok: 120, ts: NOW }),
    ];
    // sum = 120 over 120s = 1 token/s (not 3).
    expect(computeRatesBySession(entries, NOW, WINDOW)).toEqual({ all: 1, bySession: { s: 1 } });
  });

  test('dedup keeps max tok and max ts within an id group', () => {
    const entries = [
      entry({ id: 'a', tok: 60, ts: NOW - 10_000 }),
      entry({ id: 'a', tok: 240, ts: NOW - 5_000 }), // max tok=240, max ts=NOW-5000
      entry({ id: 'a', tok: 100, ts: NOW - 50_000 }),
    ];
    // One group: tok=240 → all = round(240/120) = 2.
    expect(computeRatesBySession(entries, NOW, WINDOW)).toEqual({ all: 2, bySession: { s: 2 } });
  });

  test('idle: all ts older than end-windowMs → all 0, empty bySession', () => {
    const entries = [
      entry({ id: 'a', tok: 5000, ts: NOW - WINDOW - 1 }),
      entry({ id: 'b', tok: 5000, ts: NOW - 10 * WINDOW }),
    ];
    // end = max(NOW, maxTs) = NOW; winStart = NOW - WINDOW; both ts < winStart → nothing selected.
    expect(computeRatesBySession(entries, NOW, WINDOW)).toEqual({ all: 0, bySession: {} });
  });

  test('per-session breakdown: each session its own slice, all is the sum', () => {
    const entries = [
      entry({ id: 'm1', tok: 120, ts: NOW, session: 'me' }),
      entry({ id: 'm2', tok: 120, ts: NOW - 1000, session: 'me' }),
      entry({ id: 'o1', tok: 240, ts: NOW - 2000, session: 'other' }),
    ];
    const rates = computeRatesBySession(entries, NOW, WINDOW);
    // all = round((120+120+240)/120) = 4; me = round(240/120) = 2; other = round(240/120) = 2.
    expect(rates).toEqual({ all: 4, bySession: { me: 2, other: 2 } });
    // The invariant the render relies on: a session's slice never exceeds all.
    expect(rates.bySession.me).toBeLessThanOrEqual(rates.all);
  });

  test('window boundary is inclusive on both edges', () => {
    // end = NOW (no ts exceeds now). winStart = NOW - WINDOW.
    const entries = [
      entry({ id: 'start', tok: 120, ts: NOW - WINDOW }), // exactly winStart → included
      entry({ id: 'end', tok: 120, ts: NOW }), //              exactly end → included
      entry({ id: 'before', tok: 999, ts: NOW - WINDOW - 1 }), // just outside → excluded
    ];
    // included: 120 + 120 = 240 → round(240/120) = 2.
    expect(computeRatesBySession(entries, NOW, WINDOW)).toEqual({ all: 2, bySession: { s: 2 } });
  });

  test('a slightly-future ts (clock skew, within tolerance) extends the window end', () => {
    const future = NOW + 30_000; // 30s ahead, under the 60s skew tolerance
    const entries = [
      entry({ id: 'future', tok: 120, ts: future }),
      entry({ id: 'old', tok: 120, ts: NOW - WINDOW }), // now excluded: end-windowMs slid forward
    ];
    // end = future; winStart = future - WINDOW = NOW - 90_000. old.ts = NOW-120_000 < winStart → excluded.
    expect(computeRatesBySession(entries, NOW, WINDOW)).toEqual({ all: 1, bySession: { s: 1 } });
  });

  test('a wildly-future ts outlier does NOT zero the rate (clock-skew guard)', () => {
    const outlier = NOW + 24 * 3600 * 1000; // a day ahead — corrupt row / bad clock
    const entries = [
      entry({ id: 'real', tok: 120, ts: NOW }),
      entry({ id: 'bad', tok: 9999, ts: outlier }),
    ];
    // Without the guard, end = outlier would slide winStart past `real` → all 0.
    // With it, the outlier is ignored for `end` (and, being past end, excluded from the sum),
    // so `real` still counts: end = NOW, winStart = NOW - WINDOW → all = round(120/120) = 1.
    expect(computeRatesBySession(entries, NOW, WINDOW)).toEqual({ all: 1, bySession: { s: 1 } });
  });

  test('rounds to nearest integer (half rounds up)', () => {
    // tok=60 over 120s = 0.5 → Math.round(0.5) = 1.
    expect(computeRatesBySession([entry({ id: 'a', tok: 60, ts: NOW })], NOW, WINDOW)).toEqual({
      all: 1,
      bySession: { s: 1 },
    });
    // tok=59 over 120s = 0.491… → rounds to 0 (both all and the session slice).
    expect(computeRatesBySession([entry({ id: 'b', tok: 59, ts: NOW })], NOW, WINDOW)).toEqual({
      all: 0,
      bySession: { s: 0 },
    });
    // tok=90 over 120s = 0.75 → rounds to 1.
    expect(computeRatesBySession([entry({ id: 'c', tok: 90, ts: NOW })], NOW, WINDOW)).toEqual({
      all: 1,
      bySession: { s: 1 },
    });
  });

  test('non-positive / non-finite window → all 0, empty bySession (guards CCSS_WINDOW=0)', () => {
    const entries = [entry({ id: 'a', tok: 5000, ts: NOW })];
    expect(computeRatesBySession(entries, NOW, 0)).toEqual({ all: 0, bySession: {} });
    expect(computeRatesBySession(entries, NOW, -1000)).toEqual({ all: 0, bySession: {} });
    expect(computeRatesBySession(entries, NOW, Number.NaN)).toEqual({ all: 0, bySession: {} });
  });
});
