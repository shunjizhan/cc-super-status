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
  /** input_tokens + output_tokens for the message. */
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
  /** quota bar width in cells (default 10). */
  cells: number;
  /** transcript mtime lookback in ms (default windowSec*1000 + 60_000 buffer). */
  lookbackMs: number;
  /** max bytes read from the tail of each transcript (default 1_048_576). */
  tailBytes: number;
  /** transcripts root, default `${HOME}/.claude/projects`. */
  projectsDir: string;
}
