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

/**
 * Base-layer (final reserve) colour for a quota percentage: red (<20), amber (<50), else
 * the Aurora emerald that anchors the palette. This IS the low-quota warning — the base
 * fades emerald → amber → red as it empties.
 */
export const quotaRgb = (pct: number): [number, number, number] =>
  pct < 20 ? [239, 68, 68] : pct < 50 ? [244, 168, 54] : [52, 211, 153];

/**
 * Aurora surplus palette — the colours of the quota layers ABOVE the emerald base, ordered
 * base-adjacent → top. An even cool hue sweep (cyan → blue → violet) that harmonises with
 * the emerald base and stays distinguishable at status-line size. Index i is surplus layer
 * (i + 2)'s colour; clamped for any tier deeper than the palette (only 1- and 4-layer plans
 * exist today).
 */
const AURORA: [number, number, number][] = [
  [34, 211, 238], // cyan   — first layer above the base
  [96, 165, 250], // blue
  [167, 139, 250], // violet — top of a 4-layer (Max 20x) stack
];

/**
 * Neutral gray track for the base layer's consumed cells — nothing lies beneath the base to
 * reveal, so it's a plain muted gray rather than a peek at a lower layer. Mid-gray reads clearly
 * as an empty track on a light terminal (a darker slate looked black there) and stays recessive
 * on a dark one.
 */
export const DIM: [number, number, number] = [160, 160, 160];

/**
 * Colour of quota layer `n` (1 = the green base reserve, 2… = the surplus layers stacked
 * above it). The base runs the danger gradient — `quotaRgb` of the base's own remaining % —
 * so the final layer still fades green→amber→red as it empties and the low-quota warning
 * survives (for a 1-layer plan this is exactly the old colour rule). Surplus layers are
 * static Aurora identity colours, so which reserve you're on reads at a glance.
 * `baseRemainingPct` is consulted only for the base (n ≤ 1).
 */
export const layerColor = (n: number, baseRemainingPct: number): [number, number, number] =>
  n <= 1 ? quotaRgb(baseRemainingPct) : AURORA[Math.min(n - 2, AURORA.length - 1)];

/**
 * Mute a colour: desaturate 35% toward its own luma, then darken to 60%. Used two ways — for the
 * FRONTIER cell (the fill dimmed, so the cell being consumed reads as half-spent, between the
 * solid fill and the empty track) and for the consumed track's beneath-layer underlay (which
 * recedes, its hue surviving enough to still say which layer is coming next).
 */
export const dimColor = ([r, g, b]: [number, number, number]): [number, number, number] => {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const f = (c: number): number => Math.round((c + (luma - c) * 0.35) * 0.6);
  return [f(r), f(g), f(b)];
};

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
 * Render one window as "<timeLeft> <pct>% <bar>" — a fighting-game layered bar. The bar is
 * a fixed `cells` wide and shows only the CURRENT layer; `layers` (the plan multiple) sets
 * both the displayed max and the stack depth:
 *   - displayPct = pct × layers (0 → layers×100) is the number shown (100% remaining on a
 *     4-layer plan reads 400%, and consuming one layer drops it to 300%);
 *   - the bar splits into three runs. `solid = floor(fraction × cells)` cells are FULLY HELD,
 *     drawn in the current layer's colour. The next single cell is the FRONTIER — the one being
 *     consumed right now — drawn as a dimmed shade of the fill (`dimColor`); it shows until the
 *     layer is 100% full (solid === cells). The rest is the CONSUMED track: the layer beneath
 *     muted (`dimColor`) on a surplus layer, or the neutral gray `DIM` on the base. A cell turns
 *     solid only once fully held, so the frontier sits one cell past the solid run (a 20-cell
 *     base: 95% → 19 solid + 1 dim frontier + 0 empty; 90% → 18 + 1 + 1; 5% → 1 + 1 + 18; 100% → 20
 *     solid, no frontier);
 *   - the base layer keeps the emerald→amber→red danger gradient (see `layerColor`), so a
 *     nearly-empty final reserve still warns. A 1-layer plan is a single such bar — the same
 *     0–100% emerald/amber/red readout, a dim frontier over a dim gray track.
 * The %-label takes the current layer's colour too, so the number's hue echoes the bar.
 */
const renderLane = (lane: QuotaLane, cells: number, layers: number): string => {
  const displayPct = lane.pct * layers; // 0 .. layers*100
  const current = clamp(Math.ceil(displayPct / 100), 1, layers); // 1 = base … layers = top
  const withinPct = clamp(displayPct - (current - 1) * 100, 0, 100); // remaining in this layer
  // solid = cells FULLY HELD; the single FRONTIER cell is the one being consumed right now
  // (dimmed); the rest is the consumed track. floor() means a cell turns solid only once fully
  // held, so the frontier sits one cell past the solid run. It shows until the layer is 100% full.
  const solid = clamp(Math.floor((withinPct / 100) * cells), 0, cells);
  const hasFrontier = solid < cells;
  const empty = cells - solid - (hasFrontier ? 1 : 0);

  const fillRgb = layerColor(current, withinPct);
  // The consumed track reveals the layer directly beneath, muted (dimColor) so it recedes; the
  // base has nothing beneath, so its consumed cells are the neutral gray DIM.
  const hasBeneath = current > 1;
  const emptyRgb = hasBeneath ? dimColor(layerColor(current - 1, 100)) : DIM;
  // Three runs, left → right, any zero-width one skipped so no stray colour escape:
  //   1. the SOLID run — cells fully held, in the current layer's colour,
  //   2. the FRONTIER — the single cell being consumed, a dimmed shade of the fill,
  //   3. the consumed run — muted layer beneath, or the dim gray DIM on the base.
  const bar =
    (solid > 0 ? truecolor('▰'.repeat(solid), fillRgb) : '') +
    (hasFrontier ? truecolor('▰', dimColor(fillRgb)) : '') +
    (empty > 0 ? truecolor('▰'.repeat(empty), emptyRgb) : '');

  return `${lane.timeLeft} ${truecolor(`${Math.round(displayPct)}%`, fillRgb)} ${bar}`;
};

/**
 * Render the whole ⚡ segment: one layered bar per present window, space-separated (the
 * 5-hour window leads, the weekly window follows). `cells` is the fixed per-layer width and
 * `layers` the plan's stack depth (see `renderLane`). Returns '' when both lanes are absent
 * (caller omits ⚡).
 */
export const formatQuotaSegment = (
  fiveHour: QuotaLane | null,
  sevenDay: QuotaLane | null,
  cells: number,
  layers: number,
): string => {
  const pieces: string[] = [];
  if (fiveHour) pieces.push(renderLane(fiveHour, cells, layers));
  if (sevenDay) pieces.push(renderLane(sevenDay, cells, layers));
  return pieces.length ? `⚡ ${pieces.join(' ')}` : '';
};
