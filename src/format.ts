// cc-super-status — pure formatting/rendering helpers for the status line.
// All functions here are pure: same input → same output, no I/O, no side effects.

import type { ActiveCounts, QuotaLane, Rates } from './types';

/** Clamp `n` into the inclusive range [lo, hi]. */
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Per-model emoji for the model segment, matched on the display name or id:
 * Fable → 🐉, Opus → 🥷, Sonnet → 🐱. Any other model (Haiku, unknown) keeps the
 * default 🤖.
 */
const modelEmoji = (displayName: string | undefined, modelId: string | undefined): string => {
  const hay = `${displayName ?? ''} ${modelId ?? ''}`.toLowerCase();
  if (hay.includes('fable')) return '🐉';
  if (hay.includes('opus')) return '🥷';
  if (hay.includes('sonnet')) return '🐱';
  return '🤖';
};

/**
 * Render the model segment, e.g. `🥷 Opus 4.8-1m (ultracode)`.
 * Emoji is per-model (see `modelEmoji`); name = displayName ?? modelId ?? '?', with
 * ' (1M context)' collapsed to '-1m'; effort 'xhigh' is shown as 'ultracode', omitted
 * entirely when absent.
 */
export const formatModel = (
  displayName: string | undefined,
  modelId: string | undefined,
  effortLevel: string | undefined,
): string => {
  const name = (displayName ?? modelId ?? '?').replace(' (1M context)', '-1m');
  const effort = effortLevel === 'xhigh' ? 'ultracode' : effortLevel;
  return `${modelEmoji(displayName, modelId)} ${name}` + (effort ? ` (${effort})` : '');
};

/**
 * Render the token-rate segment, collapsing when cur === all.
 * Star marks the mode: ⭐️ when charge-weighted (effective), 🌟 when raw.
 *
 * The live count of sessions and sub-agents working *right now* is always appended as
 * `<sessions>[<subagents>]` (e.g. `⭐️ {100}5470t/s 5[10]`, solo `⭐️ 5t/s 1[0]`). The
 * counts come from transcript mtimes (a short freshness window), decoupled from the
 * token-rate window — so they track live work. The suffix renders unconditionally
 * (idle shows `0[0]`), so the segment never blinks out from under the following ` | `:
 * the numbers ride down to 0 rather than the whole suffix appearing and disappearing.
 */
export const formatSpeed = (rates: Rates, counts: ActiveCounts, effectiveRate: boolean): string => {
  const star = effectiveRate ? '⭐️' : '🌟';
  const rate = rates.cur === rates.all ? `${rates.all}t/s` : `{${rates.cur}}${rates.all}t/s`;
  return `${star} ${rate} ${counts.sessions}[${counts.subagents}]`;
};

/** Render a progress bar of `cells` width filled proportionally to `pct` (0–100). */
export const renderBar = (pct: number, cells: number): string => {
  const filled = clamp(Math.floor((pct / 100) * cells), 0, cells);
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
};

/** Pick an RGB triple for a quota percentage: red (<20), amber (<50), green (else). */
export const quotaRgb = (pct: number): [number, number, number] =>
  pct < 20 ? [255, 85, 85] : pct < 50 ? [240, 190, 70] : [90, 205, 115];

/** Wrap `text` in a 24-bit truecolor ANSI foreground escape, then reset. */
export const truecolor = (text: string, rgb: [number, number, number]): string =>
  `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;

/**
 * Format a duration as "2h 35m" / "45m" (floor to the minute, ccusage style).
 * Zero or negative durations clamp to "0m". Used for the 5-hour window.
 */
export const formatResetDuration = (ms: number): string => {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/**
 * Format a long duration as "3d 2h" / "5h" (floor to the hour, minutes dropped).
 * Used for the 7-day (weekly) window, where minute precision is noise.
 * Zero or negative durations clamp to "0h".
 */
export const formatWeeklyDuration = (ms: number): string => {
  const totalHours = Math.max(0, Math.floor(ms / 3_600_000));
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
};

/** pct remaining = 100 - used_percentage, clamped to [0, 100]. */
const remainingPct = (usedPercentage: number): number => clamp(Math.round(100 - usedPercentage), 0, 100);

/**
 * 5-hour lane from Claude Code's first-party five_hour window:
 * time = resets_at (epoch seconds) - now, shown to the minute.
 */
export const fiveHourLane = (usedPercentage: number, resetsAtSec: number, now: number): QuotaLane => ({
  pct: remainingPct(usedPercentage),
  timeLeft: formatResetDuration(resetsAtSec * 1000 - now),
});

/** 5-hour lane from the ccusage $ estimate: (quota - block) / quota (fallback path). */
export const ccusageLane = (timeLeft: string, blockCost: number, quota: number): QuotaLane => ({
  pct: clamp(Math.round(((quota - blockCost) / quota) * 100), 0, 100),
  timeLeft,
});

/**
 * Weekly lane from Claude Code's first-party seven_day window:
 * time = resets_at (epoch seconds) - now, shown as days+hours (no minutes).
 */
export const sevenDayLane = (usedPercentage: number, resetsAtSec: number, now: number): QuotaLane => ({
  pct: remainingPct(usedPercentage),
  timeLeft: formatWeeklyDuration(resetsAtSec * 1000 - now),
});

/**
 * Render one window: "<timeLeft> <pct>% <bar>", with the "<pct>% <bar>" tail colour-coded.
 * Each cell is a fixed 10% increment, so a scaled bar counts down from a proportionally
 * higher max — 40 cells (Max 20x / max mode) → 0–400%. The bar fill and the red/amber/green
 * colour stay keyed on the true 0–100 remaining fraction (equivalently, the thresholds scale
 * with the bar), so a low-quota warning still fires at the right moment, not 4× too late.
 */
const renderLane = (lane: QuotaLane, cells: number): string => {
  const shownPct = Math.round((lane.pct * cells) / 10);
  return `${lane.timeLeft} ${truecolor(`${shownPct}% ${renderBar(lane.pct, cells)}`, quotaRgb(lane.pct))}`;
};

/**
 * Render the whole ⚡ segment: one solid bar per present window, space-separated
 * (the 5-hour window leads, the weekly window follows). Each window renders as
 * "<timeLeft> <pct>% <bar>" with the "<pct>% <bar>" tail colour-coded. Returns ''
 * when both lanes are absent (caller omits ⚡).
 */
export const formatQuotaSegment = (
  fiveHour: QuotaLane | null,
  sevenDay: QuotaLane | null,
  cells: number,
): string => {
  const pieces: string[] = [];
  if (fiveHour) pieces.push(renderLane(fiveHour, cells));
  if (sevenDay) pieces.push(renderLane(sevenDay, cells));
  return pieces.length ? `⚡ ${pieces.join(' ')}` : '';
};
