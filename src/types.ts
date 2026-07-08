// cc-super-status — shared contract. Every module implements against these types.
//
// Final status line (segments joined by " | "):
//   🤖 <model> (<effort>) | 🔥 <burn> | ⭐️ {<cur>}<all>t/s <sessions>[<subagents>] | 💰 $<session> / $<block> / $<today> | ⚡ <5hTime> <5h%> <bar> <7dTime> <7d%> <bar>
//
// Data flows on three clocks (see README "Multi-session architecture"), each sized to
// what its data costs, so no render ever waits on something slow:
//   - Instant (every tick, from stdin)  → 🤖 model + effort; 💰 session $ (cost.total_cost_usd)
//   - 5s snapshot (leader walk, shared) → ⭐️ rate {cur}all; ⭐️ active counts; ⚡ quota bars
//   - 30s job (detached ccusage, shared)→ 🔥 burn; 💰 block + today $; ⚡ fallback bar
//
// The 5s + 30s outputs are frozen into a SharedSnapshot on disk so every open session's
// pane renders byte-identical globals within a generation. A pane's own `cur` rate and
// session $ are legitimately per-pane (cur = its slice of the snapshot's per-session rates;
// session $ from its own stdin). Segments still fail independently — a missing source drops
// only its segment.

/**
 * One first-party rate-limit window from Claude Code's stdin data
 * (`rate_limits.five_hour` / `.seven_day`, present for Claude.ai Pro/Max
 * subscribers on Claude Code ≥2.1.132, after the first API response).
 */
export interface RateLimitWindow {
  /** 0–100, may be fractional. */
  used_percentage?: number;
  /** When the window resets — Unix epoch SECONDS (not ms). */
  resets_at?: number;
}

/**
 * One quota window reduced to what the ⚡ segment renders: remaining percentage
 * and a formatted time-to-reset. Source-agnostic — a lane can come from a
 * first-party rate-limit window or (for the 5-hour window) the ccusage estimate.
 */
export interface QuotaLane {
  /** percentage remaining, 0–100 (integer). */
  pct: number;
  /** formatted time to reset, e.g. "2h 35m" (5-hour) or "3d 2h" (weekly). */
  timeLeft: string;
}

/** Statusline JSON Claude Code passes on stdin (only the fields we use). */
export interface StatuslineInput {
  model?: { id?: string; display_name?: string };
  effort?: { level?: string };
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /**
   * Client-side session cost (`cost.total_cost_usd`, epoch-fresh on every tick).
   * The 💰 session number — instant and per-session, so it needs no ccusage. Claude
   * Code's own estimate; may differ slightly from the bill.
   */
  cost?: { total_cost_usd?: number };
  /** Each window may be independently absent; the whole object absent for API-key users. */
  rate_limits?: { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow };
}

/**
 * Rate-limit windows merged across all open sessions (see `mergeRateLimits`).
 * Same shape as stdin `rate_limits`, but each window is the freshest reading any
 * session has seen — an idle session's stale view can't drag the shared bars back.
 */
export interface MergedRateLimits {
  five_hour?: RateLimitWindow;
  seven_day?: RateLimitWindow;
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
  /**
   * Session this event belongs to — `sessionOrigin(path).session`, i.e. the main
   * transcript's basename, shared by that session's sub-agents. This is what
   * `computeRatesBySession` groups on; a pane's own `cur` is its own session's slice.
   * (Replaces the old per-consumer `current` flag — "current" is now decided at
   * render time by matching the pane's `session_id`, not baked into the entry.)
   */
  session: string;
}

/**
 * One recently-touched transcript file, reduced to what the ⭐️ activity counts
 * need. Emitted per transcript that produced ≥1 token event (so journal.jsonl and
 * other non-assistant files are excluded). `mtimeMs` is the file's last-write time
 * — the freshest "is this being worked on right now" signal on disk.
 */
export interface FileActivity {
  /** session id — main transcript basename, or the `<session_id>` dir above a subagent. */
  session: string;
  /** subagent transcript path (distinct per subagent), or null for a main transcript. */
  subagent: string | null;
  /** file modification time, epoch milliseconds. */
  mtimeMs: number;
}

/** Counts of sessions / sub-agents active right now (see `countActive`). */
export interface ActiveCounts {
  /** distinct sessions with a transcript touched within CCSS_ACTIVE_WINDOW. */
  sessions: number;
  /** distinct sub-agents with a transcript touched within CCSS_ACTIVE_WINDOW. */
  subagents: number;
}

/** Per-second token rates over the window (rounded integers). */
export interface Rates {
  /** current session. */
  cur: number;
  /** all sessions (>= cur). */
  all: number;
}

/**
 * The frozen cross-session snapshot the leader writes each ~5s generation and every
 * other pane reads (see `src/shared.ts`). Holds exactly the globals that must agree
 * across panes; per-pane bits (session $, model) are added at render time from stdin.
 */
export interface SharedSnapshot {
  /** schema version — a reader rejects a mismatch and rebuilds locally. */
  v: number;
  /** config fingerprint (`cfgKey`) — a reader ignores a snapshot built under a different config. */
  cfgKey: string;
  /** epoch ms the leader built this — the freshness clock (`readSnapshot` drops stale ones). */
  asOf: number;
  /** all-sessions per-second token rate (the ⭐️ `all`). */
  all: number;
  /** per-session per-second rate; a pane's `cur` is `bySession[session_id] ?? 0`. */
  bySession: Record<string, number>;
  /** active session / sub-agent counts (the ⭐️ `N[M]` suffix), frozen at `asOf`. */
  counts: ActiveCounts;
  /** merged rate-limit windows for the ⚡ bars, or null when no session has any. */
  limits: MergedRateLimits | null;
  /** validated global `ccusage statusline` line for 🔥/💰 block+today, or null. */
  ccusage: string | null;
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
   * Active-count freshness window in seconds (env CCSS_ACTIVE_WINDOW, default 15).
   * A transcript touched within this many seconds counts toward the ⭐️
   * `<sessions>[<subagents>]` suffix. Independent of `windowSec` — this tracks
   * live work (file mtime), not token throughput.
   */
  activeWindowSec: number;
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
  /**
   * Show the 7-day weekly rate-limit bar alongside the 5-hour bar (env CCSS_WEEKLY,
   * default false). When off, the weekly window is neither computed nor rendered —
   * the ⚡ segment is just the 5-hour bar.
   */
  showWeekly: boolean;
  /**
   * ⚡ quota bar width in cells — the number of cells drawn for ONE layer (env CCSS_CELLS,
   * default 20, each cell a fixed 5% of a layer). Fixed regardless of plan: a higher tier
   * adds layers (see `layers`), it doesn't widen the bar. An explicit CCSS_CELLS still
   * overrides the width. Render-only, so cfgKey excludes it.
   */
  cells: number;
  /**
   * ⚡ quota LAYERS — the plan's 5-hour quota multiple (`barScale` from src/plan.ts:
   * Max 20x → 4, 5x / Team / Pro / unknown → 1). The bar stacks this many colour layers
   * (fighting-game style): the fixed-width bar shows the current layer's fill, its colour
   * says which layer you're on, and the displayed max is layers×100% (4 → counts 400% → 0).
   * The base layer (1) is the green→amber→red danger reserve; surplus layers above it are
   * static identity colours (see `renderLane` / `layerColor`). CCSS_BAR_MODE picks the
   * scale (max → 4, default → 1, auto → the tier). Render-only, so cfgKey excludes it.
   */
  layers: number;
  /**
   * How stale the shared ccusage line may get before a leader spawns a fresh
   * detached recompute (env CCSS_CCUSAGE_REFRESH, default 30s). Bigger = less
   * background work at the cost of older 🔥/💰; a full recompute is ~4s, so a 5s
   * cadence would peg a core while 30s keeps it a ~13% duty cycle.
   */
  ccusageRefreshSec: number;
  /**
   * Transcript mtime lookback in ms — a file older than this is skipped entirely.
   * Must cover both consumers, so default = max(windowSec, activeWindowSec)*1000 +
   * 60_000 buffer (else a file fresh for one window could be dropped before the
   * other counts it).
   */
  lookbackMs: number;
  /** max bytes read from the tail of each transcript (default 1_048_576). */
  tailBytes: number;
  /** transcripts root, default `${HOME}/.claude/projects`. */
  projectsDir: string;
}
