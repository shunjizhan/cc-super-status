// ⭐️ token-rate computation: TokenEntry[] → Rates (per-second token rates over a window).
// Pure function — no I/O, no globals. See src/types.ts for the authoritative contract.

import type { Rates, TokenEntry } from './types';

/** One deduped group: max tok, max ts, current if ANY member is current. */
interface Deduped {
  tok: number;
  ts: number;
  current: boolean;
}

/**
 * Compute per-second token rates over a sliding window.
 *
 * Steps (pure):
 *  1. Dedup by id — keep max tok, max ts, current = OR of group.
 *  2. end = max(now, max ts); end = now when there are no entries.
 *  3. winStart = end - windowMs; select deduped entries with winStart <= ts <= end.
 *  4. sumAll over selected; sumCur over selected where current.
 *  5. Divide each by windowSec (= windowMs / 1000) and round.
 */
export const computeRate = (entries: TokenEntry[], now: number, windowMs: number): Rates => {
  // Guard a non-positive / non-finite window (e.g. CCSS_WINDOW=0) — otherwise the
  // divide-by-windowSec below yields Infinity/garbage. Self-defend even though the
  // entry point also sanitizes the config.
  if (!(windowMs > 0)) return { all: 0, cur: 0 };

  // 1. Dedup by id.
  const groups = new Map<string, Deduped>();
  for (const entry of entries) {
    const existing = groups.get(entry.id);
    if (existing === undefined) {
      groups.set(entry.id, { tok: entry.tok, ts: entry.ts, current: entry.current });
    } else {
      existing.tok = Math.max(existing.tok, entry.tok);
      existing.ts = Math.max(existing.ts, entry.ts);
      existing.current = existing.current || entry.current;
    }
  }

  const deduped = [...groups.values()];

  // 2. end = max(now, max ts over deduped); end = now when no entries.
  const end = deduped.reduce((max, d) => Math.max(max, d.ts), now);

  // 3. select within [winStart, end].
  const winStart = end - windowMs;
  const selected = deduped.filter((d) => d.ts >= winStart && d.ts <= end);

  // 4. sums.
  let sumAll = 0;
  let sumCur = 0;
  for (const d of selected) {
    sumAll += d.tok;
    if (d.current) sumCur += d.tok;
  }

  // 5. per-second, rounded.
  const windowSec = windowMs / 1000;
  return {
    all: Math.round(sumAll / windowSec),
    cur: Math.round(sumCur / windowSec),
  };
};
