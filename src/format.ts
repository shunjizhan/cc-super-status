// cc-super-status — pure formatting/rendering helpers for the status line.
// All functions here are pure: same input → same output, no I/O, no side effects.

import type { ActiveCounts, QuotaLane, Rates } from './types';

/** Clamp `n` into the inclusive range [lo, hi]. */
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** True when two RGB triples are identical — used to coalesce equal-colour cells into one run. */
const eqRgb = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

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
 * Neutral gray track for the bar's consumed cells (every cell past the frontier). A spent reserve
 * is spent, so its zone hue isn't kept — a plain muted gray both reads clearly as "empty" and keeps
 * the dimmed frontier legible against it. Mid-gray reads as an empty track on a light terminal (a
 * darker slate looked black there) and stays recessive on a dark one.
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
 * Mute a colour: desaturate 35% toward its own luma, then darken to 60%. Used for the FRONTIER
 * cell — the fill dimmed, so the cell being consumed right now reads as half-spent, sitting
 * between the bright held cells and the gray consumed track.
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
 * Render one window as "<timeLeft> <pct>% <bar>" — a fighting-game layered health bar drawn in
 * FULL. The bar is `cells × layers` wide, one contiguous `cells`-wide colour zone per layer laid
 * out left → right: the emerald base first, then the static Aurora surplus layers (cyan → blue →
 * violet). So the whole quota is on screen at once — a Max 20x plan (4 layers × 20 cells) is 80
 * cells, a 1-layer plan is just `cells` cells.
 *   - displayPct = pct × layers (0 → layers×100) is the number shown (a full window reads
 *     layers×100%, e.g. 400% on Max 20x; consuming a whole layer drops it a clean 100);
 *   - `filled = floor((pct/100) × totalCells)` cells are FULLY HELD, from the left, each in its
 *     own layer zone's colour. The single cell at index `filled` is the FRONTIER — the one being
 *     consumed right now — a dimmed shade of its zone (`dimColor`); it shows until the bar is
 *     100% full (`filled === totalCells`). Every cell past it is the CONSUMED track, a neutral
 *     gray `DIM` — a spent reserve is spent, so its hue isn't kept (which also keeps the dim
 *     frontier legible against it). As you burn quota the frontier walks LEFT through the zones;
 *     the still-held zones to its left stay bright, so you read each surviving reserve at a glance.
 *   - the base zone keeps the emerald→amber→red danger gradient on the base's OWN remaining %
 *     (`quotaRgb(min(displayPct, 100))`), so a nearly-empty final reserve still warns even while
 *     the surplus layers are full. A 1-layer plan is exactly this bar with a single emerald zone —
 *     byte-identical to before, a dim frontier over a dim gray track.
 * The %-label takes the current (top-most) layer's colour, so the number's hue echoes the bar.
 * Adjacent same-colour cells are coalesced into one truecolor run, so even an 80-cell bar emits
 * only a handful of escape sequences.
 */
const renderLane = (lane: QuotaLane, cells: number, layers: number): string => {
  const totalCells = cells * layers;
  const displayPct = lane.pct * layers; // 0 .. layers*100
  const baseRemaining = clamp(displayPct, 0, 100); // the base layer's OWN remaining % → danger colour
  const filled = clamp(Math.floor((lane.pct / 100) * totalCells), 0, totalCells); // cells fully held

  // Colour every cell by its layer zone and its state (held / frontier / consumed). `layerColor`
  // gives the zone colour: the base (layer 1) runs the danger gradient on `baseRemaining`, the
  // surplus layers are static Aurora (which ignore the second arg).
  const cellRgb = (i: number): [number, number, number] => {
    const zone = layerColor(Math.floor(i / cells) + 1, baseRemaining); // 1 = base … layers = top
    if (i < filled) return zone; // held
    if (i === filled) return dimColor(zone); // frontier — the cell being consumed right now
    return DIM; // consumed track (neutral gray)
  };
  // Coalesce runs of equal colour so we emit one escape per run, not one per cell.
  let bar = '';
  for (let i = 0; i < totalCells; ) {
    const rgb = cellRgb(i);
    let j = i + 1;
    while (j < totalCells && eqRgb(cellRgb(j), rgb)) j++;
    bar += truecolor('▰'.repeat(j - i), rgb);
    i = j;
  }

  const current = clamp(Math.ceil(displayPct / 100), 1, layers); // top-most layer → label colour
  return `${lane.timeLeft} ${truecolor(`${Math.round(displayPct)}%`, layerColor(current, baseRemaining))} ${bar}`;
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
