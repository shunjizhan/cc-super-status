// Pure orchestrator: compose the final status line from a resolved SharedSnapshot
// (the coherent cross-session globals) plus this pane's own stdin (model, session $).
//
// No I/O here — everything is passed in, so the whole render is deterministic and
// unit-testable. See src/types.ts for the authoritative contract.

import type { Config, SharedSnapshot, StatuslineInput } from './types';
import { parseCcusage } from './ccusage';
import { ccusageLane, fiveHourLane, formatModel, formatQuotaSegment, formatSpeed, sevenDayLane } from './format';

interface BuildArgs {
  input: StatuslineInput;
  /** the coherent cross-session snapshot this generation renders from (see src/shared.ts). */
  shared: SharedSnapshot;
  now: number;
  config: Config;
}

/**
 * Compose the status line. Segments joined by ' | ', in this order:
 *   a. 🤖 model + effort                     (stdin — always present)
 *   b. 🔥 burn                               (snapshot ccusage line; omitted if absent/unparseable)
 *   c. ⭐️ token rate + active session/sub-agent counts   (snapshot — always present)
 *   d. 💰 session / block / today            (session $ from stdin; block+today from the ccusage line)
 *   e. ⚡ quota: a solid bar per window (5-hour + weekly)  (merged rate_limits, ccusage fallback)
 *
 * The globals (⭐️ rate/counts, 🔥/💰 block+today, ⚡ bars) come frozen from the
 * snapshot, so every open pane in a generation prints them identically. The two
 * per-pane bits are the ⭐️ `cur` (this session's slice of the snapshot) and the 💰
 * session $ (this session's own stdin cost). The two ccusage-derived segments (🔥/💰)
 * drop together when the snapshot has no usable ccusage line; ⚡ renders from the
 * merged rate_limits independently and drops only when no quota source is present.
 */
export const buildStatusline = (args: BuildArgs): string => {
  const { input, shared, now, config } = args;

  const cc = shared.ccusage ? parseCcusage(shared.ccusage) : null;

  const segments: string[] = [];

  // a. 🤖 model — always present.
  segments.push(formatModel(input.model?.display_name, input.model?.id, input.effort?.level));

  // b. 🔥 burn rate.
  if (cc) segments.push(`🔥 ${cc.burn}`);

  // c. ⭐️/🌟 token rate + live counts — always present. `all` and the counts are the
  // frozen globals; `cur` is this pane's own session slice (0 when idle / not yet walked).
  const cur = shared.bySession[input.session_id ?? ''] ?? 0;
  segments.push(formatSpeed({ cur, all: shared.all }, shared.counts, config.effectiveRate));

  // d. 💰 session / block / today. The session $ is instant and per-pane — Claude Code's
  // own cost.total_cost_usd from stdin (falls back to the ccusage line's session figure);
  // block + today are the account-global figures from the (up-to-30s) ccusage line.
  if (cc) {
    const sessionCost =
      typeof input.cost?.total_cost_usd === 'number' ? input.cost.total_cost_usd : cc.session;
    segments.push(`💰 $${sessionCost.toFixed(1)} / $${Math.round(cc.block)} / $${Math.round(cc.today)}`);
  }

  // e. ⚡ quota — a 5-hour lane plus an optional weekly lane, each its own solid bar,
  // space-separated (see formatQuotaSegment). The 5-hour lane prefers the merged
  // first-party five_hour window (authoritative, coherent across panes), so it renders
  // even without ccusage; it falls back to the ccusage $ estimate (same rounded block the
  // 💰 segment shows, so the % agrees with the dollars). The weekly lane is opt-in
  // (config.showWeekly) and comes only from the merged seven_day window. typeof guards
  // (not just != null): the merged windows can carry nulls from stdin — a malformed field
  // must fall through, not render junk.
  const fiveHour = shared.limits?.five_hour;
  const fiveHourQuota =
    typeof fiveHour?.used_percentage === 'number' && typeof fiveHour.resets_at === 'number'
      ? fiveHourLane(fiveHour.used_percentage, fiveHour.resets_at, now)
      : cc
        ? ccusageLane(cc.timeLeft, Math.round(cc.block), config.quota)
        : null;

  const sevenDay = config.showWeekly ? shared.limits?.seven_day : undefined;
  const sevenDayQuota =
    typeof sevenDay?.used_percentage === 'number' && typeof sevenDay.resets_at === 'number'
      ? sevenDayLane(sevenDay.used_percentage, sevenDay.resets_at, now)
      : null;

  const quota = formatQuotaSegment(fiveHourQuota, sevenDayQuota, config.cells);
  if (quota) segments.push(quota);

  return segments.join(' | ');
};
