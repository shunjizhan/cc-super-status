// Pure orchestrator: compose the final status line from already-gathered inputs.
//
// No I/O here — all data (stdin JSON, ccusage line, transcript entries, clock)
// is passed in, so the whole render is deterministic and unit-testable.
// See src/types.ts for the authoritative contract.

import type { Config, StatuslineInput, TokenEntry } from './types';
import { parseCcusage } from './ccusage';
import { formatModel, formatQuota, formatRateLimitQuota, formatSpeed } from './format';
import { computeRate } from './rate';

interface BuildArgs {
  input: StatuslineInput;
  ccusageLine: string | null;
  entries: TokenEntry[];
  now: number;
  config: Config;
}

/**
 * Compose the status line. Segments joined by ' | ', in this order:
 *   a. 🤖 model + effort                    (always present)
 *   b. 🔥 burn                              (ccusage-derived; omitted if parse fails)
 *   c. ⭐️ token rate                         (always present)
 *   d. 💰 session / block / today            (ccusage-derived)
 *   e. ⚡ quota: time left + colored bar     (stdin rate_limits, ccusage fallback)
 *
 * The two ccusage-derived segments (🔥/💰) are omitted together when the
 * ccusage line is missing or unparseable; ⚡ renders from stdin rate_limits
 * independently of ccusage and drops only when both sources are absent.
 * The model + speed segments always render on their own.
 */
export const buildStatusline = (args: BuildArgs): string => {
  const { input, ccusageLine, entries, now, config } = args;

  const cc = ccusageLine ? parseCcusage(ccusageLine) : null;

  const segments: string[] = [];

  // a. 🤖 model — always present.
  segments.push(formatModel(input.model?.display_name, input.model?.id, input.effort?.level));

  // b. 🔥 burn rate.
  if (cc) segments.push(`🔥 ${cc.burn}`);

  // c. ⭐️/🌟 token rate — always present.
  segments.push(
    formatSpeed(computeRate(entries, now, config.windowSec * 1000), config.effectiveRate),
  );

  // d. 💰 session / block / today.
  if (cc) {
    segments.push(
      `💰 $${cc.session.toFixed(1)} / $${Math.round(cc.block)} / $${Math.round(cc.today)}`,
    );
  }

  // e. ⚡ quota. Prefer Claude Code's first-party five-hour rate-limit window
  // (authoritative — present for Pro/Max subscribers since CC 2.1.132), so the
  // segment renders even without ccusage. Fall back to the ccusage $ estimate,
  // using the same rounded block that the 💰 segment displays, so the "% left"
  // always agrees with the dollar amount shown (and with the old script).
  // typeof guards (not just != null): stdin is a system boundary — a null or
  // malformed field must fall through to the ccusage estimate, not render junk.
  const fiveHour = input.rate_limits?.five_hour;
  if (typeof fiveHour?.used_percentage === 'number' && typeof fiveHour.resets_at === 'number') {
    segments.push(
      formatRateLimitQuota(fiveHour.used_percentage, fiveHour.resets_at, now, config.cells),
    );
  } else if (cc) {
    segments.push(formatQuota(cc.timeLeft, Math.round(cc.block), config.quota, config.cells));
  }

  return segments.join(' | ');
};
