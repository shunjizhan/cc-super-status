// Resolve the runtime Config from environment variables — a pure function so the
// parse (including every default and the bool/num edge cases) is unit-testable.
// See src/types.ts for the field-by-field contract.

import type { Config } from './types';

/** Env as passed in — undefined for an unset key. */
type Env = Record<string, string | undefined>;

/**
 * Positive finite number from env, else fallback. Rejects "0", negatives, blanks,
 * and non-numbers (`Number('') === 0` and `Number('  ') === 0` both fail `> 0`).
 */
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Boolean from env: unset OR blank → fallback; `0/false/no/off` (any case) → false;
 * anything else → true. The blank check matters — an exported-but-empty var
 * (`CCSS_WEEKLY=` in a shell) must read as "unset", not silently flip a default-off
 * flag on (which a bare truthiness test would do, since `''` is not `0|false|no|off`).
 */
const bool = (v: string | undefined, fallback: boolean): boolean => {
  const t = v?.trim();
  if (!t) return fallback;
  return !/^(0|false|no|off)$/i.test(t);
};

/**
 * Resolve the full runtime config from an environment map. `barScale` is the account's
 * plan tier multiple (see src/plan.ts): the impure shell passes
 * `barScaleForMode(CCSS_BAR_MODE, detectRateLimitTier())` (Max 20x → 4). It sets the ⚡
 * bar's LAYER count; `cells` is the per-layer width, so the full stacked bar is
 * `cells × barScale` cells wide (Max 20x → 20×4 = 80). Defaults to 1 (single layer) so
 * `parseConfig(env)` alone is unchanged.
 */
export const parseConfig = (env: Env, barScale = 1): Config => {
  const windowSec = num(env.CCSS_WINDOW, 120);
  const activeWindowSec = num(env.CCSS_ACTIVE_WINDOW, 15);

  return {
    quota: num(env.CCSS_QUOTA, 125),
    windowSec,
    activeWindowSec,
    includeCache: bool(env.CCSS_CACHE, true),
    effectiveRate: bool(env.CCSS_EFFECTIVE, true),
    showWeekly: bool(env.CCSS_WEEKLY, false),
    cells: num(env.CCSS_CELLS, 20),
    // Plan multiple → number of stacked colour layers (Max 20x → 4). Each layer is `cells` wide,
    // so the full bar spans cells × layers.
    layers: Math.max(1, Math.round(barScale)),
    ccusageRefreshSec: num(env.CCSS_CCUSAGE_REFRESH, 30),
    // Cover BOTH transcript consumers: the rate needs files within windowSec, the live
    // counts within activeWindowSec. Use the larger (+60s buffer) so a file fresh for
    // either isn't dropped before it's counted — e.g. a large CCSS_ACTIVE_WINDOW.
    lookbackMs: Math.max(windowSec, activeWindowSec) * 1000 + 60_000,
    tailBytes: 1_048_576,
    projectsDir: `${env.HOME}/.claude/projects`,
  };
};
