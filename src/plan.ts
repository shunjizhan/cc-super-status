// Plan tier → ⚡ quota-bar length.
//
// The statusline stdin carries NO plan/subscription field (only rate_limits
// percentages), so the tier is read from Claude Code's own local account cache:
// ~/.claude.json → oauthAccount.{organization,user}RateLimitTier, e.g.
// "default_claude_max_20x". That field is undocumented internal state, so we read it
// defensively — any failure yields null and the caller keeps the default 20-cell bar.

import { readFileSync } from 'node:fs';

/** Path to Claude Code's account cache. Injectable so tests point at a fixture. */
export const claudeJsonPath = (): string => `${process.env.HOME}/.claude.json`;

/**
 * The plan's 5-hour quota multiple, baselined at Max 5× (=1×) — the ⚡ bar's LAYER count.
 * A "…claude_max_Nx" tier → N/5, so Max 20x → 20/5 = 4 stacked bar layers. Team / Pro /
 * API-key / unknown / absent → 1 (a single green base layer). Pure. `Math.max(1, …)` guards a
 * hypothetical sub-5× tier so detection can only ever add layers, never drop below the base.
 */
export const planBarScale = (tier: string | null | undefined): number => {
  const m = tier?.match(/claude_max_(\d+)x/);
  return m ? Math.max(1, Number(m[1]) / 5) : 1;
};

/**
 * Resolve the ⚡ bar scale from an explicit mode plus the detected plan tier — this is
 * what env `CCSS_BAR_MODE` selects:
 *   - `max` / `4x`               → force 4 layers (the 400% stack), whatever the plan,
 *   - `default` / `normal` / `1x`→ force 1 layer (the plain 100% bar), even on Max 20x,
 *   - `auto` / unset / anything else → auto-detect from the tier (`planBarScale`).
 * Pure. Case-insensitive; a manual `CCSS_CELLS` still overrides the result downstream.
 */
export const barScaleForMode = (mode: string | undefined, tier: string | null | undefined): number => {
  switch (mode?.trim().toLowerCase()) {
    case 'max':
    case '4x':
      return 4;
    case 'default':
    case 'normal':
    case '1x':
      return 1;
    default:
      return planBarScale(tier);
  }
};

/**
 * Read the account's rate-limit tier string from ~/.claude.json, or null if the file is
 * absent / unreadable / mid-write or carries no quoted tier. Prefers whichever of
 * organizationRateLimitTier / userRateLimitTier is a non-null string (an individual Max
 * sub sets one, a null value simply doesn't match the quoted pattern and is skipped).
 * Never throws — a regex over the raw text (no full JSON.parse) so a torn read just misses.
 */
export const detectRateLimitTier = (path: string = claudeJsonPath()): string | null => {
  try {
    // simplified: full-file read (~200KB) each tick; cache by mtime if it ever shows up hot.
    const text = readFileSync(path, 'utf8');
    return text.match(/"(?:organization|user)RateLimitTier"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
};
