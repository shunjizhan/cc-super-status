import { describe, expect, it } from 'bun:test';

import type { CcusageData } from '../src/types';
import { parseCcusage } from '../src/ccusage';

describe('parseCcusage', () => {
  it('parses the example line into all five fields', () => {
    const line =
      '🤖 Opus 4.8 (1M context) | 💰 $-0.00 session / $313.92 today / $15.21 block (4h 15m left) | 🔥 $21.01/hr | 🧠 66,429 (7%)';

    const result = parseCcusage(line);

    expect(result).toEqual({
      session: -0,
      today: 313.92,
      block: 15.21,
      burn: '$21.01/hr',
      timeLeft: '4h 15m',
    } satisfies CcusageData);
  });

  it('parses a negative session value', () => {
    const line =
      '🤖 Opus 4.8 | 💰 $-12.34 session / $50.00 today / $7.50 block (2h 35m left) | 🔥 $13.18/hr | 🧠 1,000 (2%)';

    const result = parseCcusage(line);

    expect(result).not.toBeNull();
    expect(result?.session).toBe(-12.34);
    expect(result?.today).toBe(50);
    expect(result?.block).toBe(7.5);
    expect(result?.burn).toBe('$13.18/hr');
    expect(result?.timeLeft).toBe('2h 35m');
  });

  it('returns null on a malformed line', () => {
    expect(parseCcusage('this is not a ccusage statusline')).toBeNull();
    expect(parseCcusage('💰 $5.00 session only, no today/block')).toBeNull();
    expect(parseCcusage('')).toBeNull();
  });
});
