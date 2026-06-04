// cc-super-status — shared contract. Every module implements against these types.
//
// Final status line (segments joined by " | "):
//   🤖 <model>-1m (<effort>) | 🔥 <burn> | ⭐️ {<cur>}<all>t/s | 💰 $<session> / $<block> / $<today> | ⚡ <timeLeft>, <pct>% left <bar>
//
// Segment data sources are independent (so each can fail/degrade alone):
//   - 🤖 model + effort  ← stdin JSON (StatuslineInput)
//   - 🔥 / 💰 / ⚡        ← `ccusage statusline` output (CcusageData)
//   - ⭐️ token rates     ← transcripts on disk (TokenEntry[] → Rates)

/** Statusline JSON Claude Code passes on stdin (only the fields we use). */
export interface StatuslineInput {
  model?: { id?: string; display_name?: string };
  effort?: { level?: string };
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

/** One deduped token event from a transcript line (a single assistant message). */
export interface TokenEntry {
  /** message.id (fallback: the raw timestamp string) — the dedup key. */
  id: string;
  /**
   * Weighted token count for the message. The components summed are
   * input_tokens + output_tokens, plus cache_creation_input_tokens +
   * cache_read_input_tokens when Config.includeCache is on (the default).
   *
   * When Config.effectiveRate is on (the default), each component is scaled by its
   * Anthropic charge ratio relative to base input price — output ×5, cache write ×2
   * (all treated as 1-hour), cache read ×0.1, input ×1 — so the ⭐️ rate reflects
   * cost-equivalent ("charge") tokens and the value may be fractional. When off,
   * every weight is 1 and (with cache included) `tok` matches ccusage's total-token
   * definition, so the 🌟 rate's amounts agree with what ccusage reports.
   */
  tok: number;
  /** message timestamp, epoch milliseconds. */
  ts: number;
  /** true if it belongs to the current session (main transcript OR its subagents). */
  current: boolean;
}

/** Per-second token rates over the window (rounded integers). */
export interface Rates {
  /** current session. */
  cur: number;
  /** all sessions (>= cur). */
  all: number;
}

/** Structured data parsed from one `ccusage statusline` output line. */
export interface CcusageData {
  /** $ spent this session. */
  session: number;
  /** $ spent today. */
  today: number;
  /** $ spent in the current 5-hour block. */
  block: number;
  /** burn-rate text exactly as ccusage emits it, e.g. "$13.18/hr". */
  burn: string;
  /** time left in the block, e.g. "2h 35m". */
  timeLeft: string;
}

/** Resolved runtime config (constants + env overrides). */
export interface Config {
  /** $ quota per 5-hour block (env CCSS_QUOTA, default 125). */
  quota: number;
  /** rate sliding-window in seconds (env CCSS_WINDOW, default 120). */
  windowSec: number;
  /**
   * Count cache tokens (cache_creation + cache_read) in the ⭐️ rate, on top of
   * input + output (env CCSS_CACHE, default true). Off → input + output only. On
   * with effectiveRate off → consistent with ccusage's total-token definition.
   */
  includeCache: boolean;
  /**
   * Weight the rate by Anthropic charge ratios instead of counting raw tokens
   * (env CCSS_EFFECTIVE, default true). On → output ×5, cache write ×2, cache read
   * ×0.1, input ×1, so the rate tracks cost-equivalent tokens (shown with ⭐️).
   * Off → every token counts as 1, i.e. raw throughput (shown with 🌟).
   */
  effectiveRate: boolean;
  /** quota bar width in cells (default 10). */
  cells: number;
  /** transcript mtime lookback in ms (default windowSec*1000 + 60_000 buffer). */
  lookbackMs: number;
  /** max bytes read from the tail of each transcript (default 1_048_576). */
  tailBytes: number;
  /** transcripts root, default `${HOME}/.claude/projects`. */
  projectsDir: string;
}
