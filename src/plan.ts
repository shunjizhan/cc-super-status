// Reads of Claude Code's own local account cache, ~/.claude.json.
//
// The statusline stdin carries no plan/subscription field and no account identity (only
// rate_limits percentages), so both come from this file: oauthAccount.{organization,user}
// RateLimitTier (e.g. "default_claude_max_20x") sets the ⚡ bar's layer count, and
// oauthAccount.accountUuid scopes the shared rate-limit merge. Both are undocumented
// internal state, so every read here is defensive — any failure yields null and the caller
// degrades (the default single-layer bar / one unscoped merge bucket), never throws.

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

/**
 * The signed-in account's uuid (oauthAccount.accountUuid), or null if the file is absent /
 * unreadable / mid-write or carries no uuid. This is what scopes the machine-wide
 * rate-limit merge (see `parseStoredLimits` in src/shared.ts): an account switch changes
 * it, and a merge stamped with a different uuid is discarded rather than ratcheted forward.
 *
 * Anchored on the "oauthAccount" key rather than matching the first "accountUuid" in the
 * file: cachedUsageUtilization carries an accountUuid too, and right after a switch that
 * copy can still name the PREVIOUS account — the exact reading this scoping exists to
 * reject. Never throws; a torn read just misses and the merge reseeds from live stdin.
 */
export const detectAccountUuid = (path: string = claudeJsonPath()): string | null => {
  try {
    const text = readFileSync(path, 'utf8');
    const account = /"oauthAccount"\s*:\s*\{/.exec(text);
    if (!account) return null;
    return text.slice(account.index).match(/"accountUuid"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
};
