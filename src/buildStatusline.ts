// Pure orchestrator: compose the final status line from already-gathered inputs.
//
// No I/O here — all data (stdin JSON, ccusage line, transcript entries, clock)
// is passed in, so the whole render is deterministic and unit-testable.
// See src/types.ts for the authoritative contract.

import type { Config, FileActivity, StatuslineInput, TokenEntry } from './types';
import { parseCcusage } from './ccusage';
import { ccusageLane, fiveHourLane, formatModel, formatQuotaSegment, formatSpeed, sevenDayLane } from './format';
import { computeRate } from './rate';
import { countActive } from './transcripts';

interface BuildArgs {
  input: StatuslineInput;
  ccusageLine: string | null;
  entries: TokenEntry[];
  /** per-file activity for the ⭐️ live session/sub-agent counts. */
  files: FileActivity[];
  now: number;
  config: Config;
}

/**
 * Compose the status line. Segments joined by ' | ', in this order:
 *   a. 🤖 model + effort                    (always present)
 *   b. 🔥 burn                              (ccusage-derived; omitted if parse fails)
 *   c. ⭐️ token rate + active session/sub-agent counts   (always present)
 *   d. 💰 session / block / today            (ccusage-derived)
 *   e. ⚡ quota: a solid bar per window (5-hour + weekly), space-separated (stdin rate_limits, ccusage fallback)
 *
 * The two ccusage-derived segments (🔥/💰) are omitted together when the
 * ccusage line is missing or unparseable; ⚡ renders from stdin rate_limits
 * independently of ccusage and drops only when both sources are absent.
 * The model + speed segments always render on their own.
 */
export const buildStatusline = (args: BuildArgs): string => {
  const { input, ccusageLine, entries, files, now, config } = args;

  const cc = ccusageLine ? parseCcusage(ccusageLine) : null;

  const segments: string[] = [];

  // a. 🤖 model — always present.
  segments.push(formatModel(input.model?.display_name, input.model?.id, input.effort?.level));

  // b. 🔥 burn rate.
  if (cc) segments.push(`🔥 ${cc.burn}`);

  // c. ⭐️/🌟 token rate + live session/sub-agent counts — always present. The rate
  // uses the token sliding window; the counts use a separate short mtime window
  // (config.activeWindowSec) so they reflect who is working *now*, not recent throughput.
  segments.push(
    formatSpeed(
      computeRate(entries, now, config.windowSec * 1000),
      countActive(files, now, config.activeWindowSec * 1000),
      config.effectiveRate,
    ),
  );

  // d. 💰 session / block / today.
  if (cc) {
    segments.push(
      `💰 $${cc.session.toFixed(1)} / $${Math.round(cc.block)} / $${Math.round(cc.today)}`,
    );
  }

  // e. ⚡ quota — a 5-hour lane plus an optional weekly lane, each rendered as its
  // own solid bar, space-separated (see formatQuotaSegment). The 5-hour lane prefers
  // Claude Code's first-party five_hour window (authoritative — Pro/Max, CC ≥2.1.132),
  // so it renders even without ccusage; it falls back to the ccusage $ estimate (same
  // rounded block the 💰 segment shows, so the % agrees with the dollars). The weekly
  // lane is opt-in (config.showWeekly, env CCSS_WEEKLY, default off) and comes only
  // from the first-party seven_day window (no ccusage equivalent) — when off it is
  // neither read nor computed. typeof guards (not just != null): stdin is a system
  // boundary — a null or malformed field must fall through, not render junk.
  const fiveHour = input.rate_limits?.five_hour;
  const fiveHourQuota =
    typeof fiveHour?.used_percentage === 'number' && typeof fiveHour.resets_at === 'number'
      ? fiveHourLane(fiveHour.used_percentage, fiveHour.resets_at, now)
      : cc
        ? ccusageLane(cc.timeLeft, Math.round(cc.block), config.quota)
        : null;

  const sevenDay = config.showWeekly ? input.rate_limits?.seven_day : undefined;
  const sevenDayQuota =
    typeof sevenDay?.used_percentage === 'number' && typeof sevenDay.resets_at === 'number'
      ? sevenDayLane(sevenDay.used_percentage, sevenDay.resets_at, now)
      : null;

  const quota = formatQuotaSegment(fiveHourQuota, sevenDayQuota, config.cells);
  if (quota) segments.push(quota);

  return segments.join(' | ');
};
