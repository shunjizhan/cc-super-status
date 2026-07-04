// ⭐️ token-rate computation: TokenEntry[] → per-second rates over a window.
// Pure functions — no I/O, no globals. See src/types.ts for the authoritative contract.

import type { TokenEntry } from './types';

/** One deduped group: max tok, max ts, its session (consistent within an id group). */
interface Deduped {
  tok: number;
  ts: number;
  session: string;
}

/**
 * How far a transcript timestamp may lead `now` and still be trusted (1 minute).
 * A just-written entry can sit slightly in the future when the pane's clock trails
 * the machine that wrote the transcript — we must keep those (dropping them would
 * under-report a live session). But a wildly-future timestamp (corrupt row, badly
 * wrong clock) must not set the window's end far ahead, which would slide `winStart`
 * past every real entry and zero the rate. So the end is computed only from entries
 * within this skew; anything beyond it is ignored for `end` and, being past `end`,
 * also excluded from the sum.
 */
const CLOCK_SKEW_MS = 60_000;

/**
 * Dedup by id and select the entries inside the sliding window.
 *
 *  1. Dedup by id — keep max tok, max ts (duplicate transcript rows carry identical
 *     usage, so max is exact); session is constant within a group (one message → one file).
 *  2. end = max(now, latest ts among entries no more than CLOCK_SKEW_MS in the future);
 *     end = now when there are no (trusted) entries.
 *  3. winStart = end - windowMs; keep deduped entries with winStart <= ts <= end.
 */
const dedupeSelect = (entries: TokenEntry[], now: number, windowMs: number): Deduped[] => {
  const groups = new Map<string, Deduped>();
  for (const entry of entries) {
    const existing = groups.get(entry.id);
    if (existing === undefined) {
      groups.set(entry.id, { tok: entry.tok, ts: entry.ts, session: entry.session });
    } else {
      existing.tok = Math.max(existing.tok, entry.tok);
      existing.ts = Math.max(existing.ts, entry.ts);
    }
  }

  const deduped = [...groups.values()];

  const skewCap = now + CLOCK_SKEW_MS;
  const end = deduped.reduce((max, d) => (d.ts <= skewCap ? Math.max(max, d.ts) : max), now);
  const winStart = end - windowMs;

  return deduped.filter((d) => d.ts >= winStart && d.ts <= end);
};

/** Per-second rate: sum of `tok` over the window, divided by window seconds, rounded. */
const perSecond = (sumTok: number, windowMs: number): number =>
  Math.round(sumTok / (windowMs / 1000));

/**
 * Compute per-second token rates over a sliding window, split by session.
 *
 * Returns the all-sessions rate plus a per-session breakdown; a pane's own `cur` is
 * `bySession[its session_id] ?? 0`. `all >= bySession[x]` always (the sum dominates any
 * one session and `Math.round` is monotone), so the rendered `{cur}all` never inverts.
 *
 * Guards a non-positive / non-finite window (e.g. CCSS_WINDOW=0) — otherwise the
 * divide-by-window below yields Infinity/garbage. Self-defends even though the entry
 * point also sanitizes the config.
 */
export const computeRatesBySession = (
  entries: TokenEntry[],
  now: number,
  windowMs: number,
): { all: number; bySession: Record<string, number> } => {
  if (!(windowMs > 0)) return { all: 0, bySession: {} };

  const selected = dedupeSelect(entries, now, windowMs);

  let sumAll = 0;
  const sumBySession = new Map<string, number>();
  for (const d of selected) {
    sumAll += d.tok;
    sumBySession.set(d.session, (sumBySession.get(d.session) ?? 0) + d.tok);
  }

  const bySession: Record<string, number> = {};
  for (const [session, sum] of sumBySession) bySession[session] = perSecond(sum, windowMs);

  return { all: perSecond(sumAll, windowMs), bySession };
};
