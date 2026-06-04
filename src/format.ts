// cc-super-status — pure formatting/rendering helpers for the status line.
// All functions here are pure: same input → same output, no I/O, no side effects.

import type { Rates } from './types';

/** Clamp `n` into the inclusive range [lo, hi]. */
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Render the 🤖 model segment.
 * name = displayName ?? modelId ?? '?', with ' (1M context)' collapsed to '-1m';
 * effort 'xhigh' is shown as 'ultracode'; omitted entirely when absent.
 */
export const formatModel = (
  displayName: string | undefined,
  modelId: string | undefined,
  effortLevel: string | undefined,
): string => {
  const name = (displayName ?? modelId ?? '?').replace(' (1M context)', '-1m');
  const effort = effortLevel === 'xhigh' ? 'ultracode' : effortLevel;
  return `🤖 ${name}` + (effort ? ` (${effort})` : '');
};

/**
 * Render the token-rate segment, collapsing when cur === all.
 * Star marks the mode: ⭐️ when charge-weighted (effective), 🌟 when raw.
 */
export const formatSpeed = (rates: Rates, effectiveRate: boolean): string => {
  const star = effectiveRate ? '⭐️' : '🌟';
  return rates.cur === rates.all
    ? `${star} ${rates.all}t/s`
    : `${star} {${rates.cur}}${rates.all}t/s`;
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

/** Render the ⚡ quota segment: time left + colored "<pct>% left <bar>". */
export const formatQuota = (timeLeft: string, blockCost: number, quota: number, cells: number): string => {
  const pct = clamp(Math.round(((quota - blockCost) / quota) * 100), 0, 100);
  const bar = renderBar(pct, cells);
  const colored = truecolor(`${pct}% left ${bar}`, quotaRgb(pct));
  return `⚡ ${timeLeft}, ${colored}`;
};
