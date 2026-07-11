// ⭐️ transcript gathering: read JSONL transcripts on disk → TokenEntry[].
//
// This is the only impure piece of the rate pipeline (filesystem I/O). It walks
// the projects root for recently-modified *.jsonl transcripts, reads the tail of
// each, and extracts one TokenEntry per assistant message that carries usage.
//
// Every entry is tagged with its session (`sessionOrigin(path).session`), so the
// rate can be split per session downstream. Which session is "current" is not a
// property of the entry — it's decided at render time by matching the pane's own
// session_id against the per-session rates.
//
// See src/types.ts for the authoritative contract. Dedup / windowing / rate math
// all live downstream in src/rate.ts — this module only produces raw entries.

import { readdir, stat } from 'node:fs/promises';

import type { ActiveCounts, CachedTailState, Config, FileActivity, TokenEntry, TurnState } from './types';

/** The token usage block of one assistant message (everything optional/loose). */
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Shape of the transcript JSONL lines we care about (everything optional/loose). */
interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    usage?: Usage;
  };
}

/** Charge-rate multipliers relative to base input price (Anthropic pricing ratios). */
const CHARGE = { output: 5, cacheWrite: 2, cacheRead: 0.1 } as const;

/** How a message's token count is computed — both flags come from Config. */
interface TokOpts {
  includeCache: boolean;
  effectiveRate: boolean;
}

/**
 * Weighted token count for one message's usage.
 *
 * Raw (effectiveRate off): input + output, plus cache_creation + cache_read when
 * includeCache — every component counts as 1, matching ccusage's total tokens.
 * Effective (on, the default): each component is scaled by its Anthropic charge
 * ratio vs base input price — output ×5, cache write ×2 (all treated as 1-hour),
 * cache read ×0.1, input ×1 — so the rate reflects cost-equivalent ("charge")
 * tokens. The result may be fractional; rate.ts sums then rounds.
 */
export const tokenCount = (usage: Usage, { includeCache, effectiveRate }: TokOpts): number => {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  if (effectiveRate) {
    const cache = includeCache ? cacheWrite * CHARGE.cacheWrite + cacheRead * CHARGE.cacheRead : 0;
    return input + output * CHARGE.output + cache;
  }
  return input + output + (includeCache ? cacheWrite + cacheRead : 0);
};

/** Join path segments with '/', collapsing duplicate separators. */
const join = (...parts: string[]): string =>
  parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');

/**
 * Recursively collect every `*.jsonl` file path under `dir`.
 * Returns absolute-or-as-given paths; missing dirs yield [].
 */
const walkJsonl = async (dir: string): Promise<string[]> => {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...(await walkJsonl(full)));
    } else if (dirent.isFile() && dirent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Read the trailing `tailBytes` of a file as UTF-8 text.
 * Reading only the tail keeps us fast on multi-MB transcripts; a partial first
 * line is fine because we skip lines that fail to JSON.parse.
 */
const readTail = async (path: string, tailBytes: number): Promise<string> => {
  const file = Bun.file(path);
  const size = file.size;
  const start = size > tailBytes ? size - tailBytes : 0;
  return await file.slice(start).text();
};

/**
 * Parse the assistant lines of one transcript's text into TokenEntry[], each tagged
 * with `session` (the transcript's owning session — see `sessionOrigin`).
 *
 * `opts` (includeCache + effectiveRate) is forwarded to `tokenCount`, which bakes
 * the per-component weighting into each entry's `tok`. Downstream — dedup,
 * windowing, the per-second divide — never sees the split.
 */
export const parseTranscriptText = (
  text: string,
  session: string,
  opts: TokOpts,
): TokenEntry[] => {
  const entries: TokenEntry[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue; // partial / non-JSON line (e.g. truncated tail) — skip.
    }

    const usage = parsed.message?.usage;
    if (usage === undefined) continue;

    const tok = tokenCount(usage, opts);
    if (tok <= 0) continue;

    const tsRaw = parsed.timestamp;
    if (tsRaw === undefined) continue;
    const ts = Date.parse(tsRaw);
    if (Number.isNaN(ts)) continue;

    // Dedup key: message.id, falling back to the raw timestamp string.
    const id = parsed.message?.id ?? tsRaw;

    entries.push({ id, tok, ts, session });
  }

  return entries;
};

/**
 * Classify a transcript path into its session id and (if it's a subagent) its
 * own distinct key, independent of which session is "current".
 *  - A subagent lives under `<session_id>/subagents/…` (possibly nested, e.g.
 *    `…/subagents/workflows/<wf>/agent-*.jsonl`): session = the `<session_id>`
 *    segment before `/subagents/`, subagent = the full path.
 *  - A main transcript is `<…>/<session_id>.jsonl`: session = its basename
 *    without the extension, subagent = null.
 * A session and its subagents thus resolve to the same `session` key.
 */
export const sessionOrigin = (path: string): Pick<FileActivity, 'session' | 'subagent'> => {
  const sub = path.match(/\/([^/]+)\/subagents\//);
  if (sub) return { session: sub[1], subagent: path };
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
  return { session: base, subagent: null };
};

/** Row bits classifyTail inspects (everything optional/loose). */
interface StateLine {
  type?: string;
  subtype?: string;
  timestamp?: string;
  isMeta?: boolean;
  toolUseResult?: unknown;
  message?: { stop_reason?: string | null; content?: unknown };
}

/** A turn-state verdict plus the meaningful row time that established it. */
interface TailClassification {
  state: TurnState;
  atMs: number | null;
}

/** Parse one transcript row's timestamp, preserving null for missing/bad values. */
const rowTimestampMs = (row: StateLine): number | null => {
  if (row.timestamp === undefined) return null;
  const atMs = Date.parse(row.timestamp);
  return Number.isNaN(atMs) ? null : atMs;
};

/** System subtypes Claude Code appends right after a turn completes. */
const TURN_END_SUBTYPES = new Set(['turn_duration', 'stop_hook_summary']);

/** First text of a user row's content — string content or a leading text block. */
const firstText = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const first = content[0] as { type?: string; text?: string } | undefined;
    if (first?.type === 'text' && typeof first.text === 'string') return first.text;
  }
  return null;
};

/**
 * Whether an assistant row's content dispatches a StructuredOutput call — the
 * workflow runner's forced FINAL act. A schema-returning workflow agent never
 * writes an end_turn row (the runner stops it right after capturing the output),
 * so without this its transcript reads mid-turn until the corpse TTL. The tool
 * name is harness-defined — a rename there re-opens that bounded phantom.
 */
const callsStructuredOutput = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.some((b) => {
    const block = b as { type?: string; name?: string };
    return block.type === 'tool_use' && block.name === 'StructuredOutput';
  });

/**
 * Classify a transcript tail into the session's turn state and evidence time by
 * scanning rows backward for the last meaningful one. Claude Code writes each
 * row at the moment its event happens — the prompt at submit, tool_use rows at
 * dispatch, tool results at completion, end-of-turn system rows within ~40ms of the turn
 * finishing — so the tail mirrors the live turn state. mtime recency cannot:
 * nothing is written during long thinking/streaming stretches or long tool runs
 * (measured: busy sessions read idle 55% of their busy time on a 15s window).
 *
 * Verdicts by row (first meaningful row from the end wins):
 *  - assistant → a StructuredOutput dispatch = ended (see callsStructuredOutput);
 *    stop_reason tool_use or pause_turn (the client continues the turn) = busy;
 *    stop_reason absent = stalled — the message's blocks are mid-flush and the
 *    next row normally lands within minutes, but runner-stopped agents
 *    (text-output workflow/task agents never get an end_turn) leave this shape
 *    forever, so it decays on the short TTL; end_turn / stop_sequence / any
 *    future terminal value = ended (a phantom-busy misread is the worse failure,
 *    so unrecognized values end the turn).
 *  - user → a tool result defers state to the nearest assistant row above it but
 *    keeps the newer result timestamp as liveness evidence (mid-turn
 *    it precedes more model work = busy, but a StructuredOutput result is a
 *    workflow agent's terminal act = ended; the result row itself doesn't name
 *    the tool); an interrupt row ("[Request interrupted…", checked before isMeta
 *    — an interrupt ends the turn even when flagged meta) = ended; injected meta
 *    rows (isMeta) and slash-command rows — both the "<command-name>" wrapper
 *    form and the bare "/cmd …" string form — are skipped (a local command like
 *    /compact may never reach the model, and a phantom busy would outlast the
 *    misread by minutes); anything else is a real prompt = busy.
 *  - system → turn_duration / stop_hook_summary = ended; api_error = stalled
 *    (retrying or dead — either way short-lived evidence);
 *    every other subtype is progress noise, skipped.
 * All other row types (queue-operation, attachment, file-history-snapshot, …) are
 * skipped. Returns null when the tail holds no meaningful row at all
 * (journal.jsonl, usage-less files, or a tail swallowed by one giant row).
 */
const classifyTailState = (text: string): TailClassification | null => {
  const lines = text.split('\n');
  let sawToolResult = false;
  let toolResultAtMs: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;

    let row: StateLine;
    try {
      row = JSON.parse(raw) as StateLine;
    } catch {
      continue; // partial / non-JSON line (truncated tail or a mid-write read) — skip.
    }

    const atMs = (): number | null => (sawToolResult ? toolResultAtMs : rowTimestampMs(row));

    if (row.type === 'system') {
      if (row.subtype === 'api_error') return { state: 'stalled', atMs: atMs() };
      if (row.subtype !== undefined && TURN_END_SUBTYPES.has(row.subtype)) return { state: 'ended', atMs: atMs() };
      continue;
    }

    if (row.type === 'assistant' && row.message !== undefined) {
      if (callsStructuredOutput(row.message.content)) return { state: 'ended', atMs: atMs() };
      const stop = row.message.stop_reason;
      if (stop === 'tool_use' || stop === 'pause_turn') return { state: 'busy', atMs: atMs() };
      if (stop === undefined || stop === null) return { state: 'stalled', atMs: atMs() };
      return { state: 'ended', atMs: atMs() };
    }

    if (row.type === 'user' && row.message !== undefined) {
      const content = row.message.content;
      // Main transcripts enrich tool results with a row-level toolUseResult field;
      // subagent transcripts carry only the tool_result content block. Either marks
      // a tool result — never a prompt.
      const isToolResult =
        row.toolUseResult !== undefined ||
        (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result'));
      if (isToolResult) {
        if (!sawToolResult) toolResultAtMs = rowTimestampMs(row);
        sawToolResult = true;
        continue; // the assistant row above names the tool and decides
      }
      const text0 = firstText(content);
      if (text0?.startsWith('[Request interrupted') === true) return { state: 'ended', atMs: atMs() };
      if (row.isMeta === true) continue;
      // Slash-command rows: the "<command-name>" wrapper form, or a bare "/cmd [args]"
      // string (the leading word must contain no inner slash, so absolute paths in a
      // real prompt don't match).
      if (
        text0 !== null &&
        (text0.includes('<command-name>') || text0.includes('<local-command-stdout>') || /^\/[^\s/]+(\s|$)/.test(text0))
      ) {
        continue;
      }
      return { state: 'busy', atMs: atMs() };
    }
  }
  // Only tool results in the tail (their assistant row cut off past the tail
  // start): evidence of a turn in flight, even though nothing else survived.
  return sawToolResult ? { state: 'busy', atMs: toolResultAtMs } : null;
};

/** Public state-only classifier; gathering also retains the internal evidence time. */
export const classifyTail = (text: string): TurnState | null => classifyTailState(text)?.state ?? null;

/**
 * Corpse TTLs: how long busy / stalled evidence may age before the transcript
 * is presumed dead (a killed pane leaves a busy-looking tail forever).
 * The busy TTL clears the longest measured silent stretch of a real turn (889s)
 * with wide headroom; the stall TTL covers a mid-flush gap or a transient
 * API-retry storm but drops runner-stopped agents and dead turns fast.
 * simplified: fixed machine-wide constants — env knobs if workloads ever vary.
 */
const BUSY_TTL_MS = 30 * 60_000;
const STALL_TTL_MS = 5 * 60_000;

/** Whether one file's classified state still counts as live at `now`. */
const isLive = (f: FileActivity, now: number, activeMs: number): boolean => {
  const age = now - f.stateAtMs;
  if (f.state === 'busy') return age <= BUSY_TTL_MS;
  if (f.state === 'stalled') return age <= STALL_TTL_MS;
  if (f.state === 'ended') return false;
  return age <= activeMs; // 'unknown' — the mtime-freshness fallback lane
};

/**
 * Count the sessions and sub-agents that are active *right now*. A file is live
 * by its classified turn state — busy/stalled files stay counted through silent
 * mid-turn stretches (bounded by the corpse TTLs), ended files drop immediately,
 * and 'unknown' files fall back to the mtime-derived state time (`activeMs`). Pure: distinct
 * `session` keys → active sessions (a session groups with its own sub-agents,
 * counted once — and stays counted while only its sub-agents are busy); distinct
 * non-null `subagent` keys → active sub-agents.
 */
export const countActive = (
  files: FileActivity[],
  now: number,
  activeMs: number,
): ActiveCounts => {
  const sessions = new Set<string>();
  const subagents = new Set<string>();
  for (const f of files) {
    if (!isLive(f, now, activeMs)) continue;
    sessions.add(f.session);
    if (f.subagent !== null) subagents.add(f.subagent);
  }
  return { sessions: sessions.size, subagents: subagents.size };
};

/**
 * State lookback: how far back a transcript's mtime may be and still get its tail
 * classified. Must exceed BUSY_TTL_MS (a busy file inside the TTL must be read to
 * be counted); a file older than both lookbacks is skipped entirely. The state
 * read is smaller than the rate read — turn state lives in the last few rows.
 * simplified: a single >256KB trailing row hides the state from an older file
 * (it just stops counting once past the rate lookback) — adaptive re-reads if it
 * ever matters.
 */
const STATE_LOOKBACK_MS = 35 * 60_000;
const STATE_TAIL_BYTES = 262_144;

/**
 * Gather token events and per-file activity from every recently-modified
 * transcript under `config.projectsDir`.
 *
 * Steps (impure — filesystem I/O):
 *  1. Walk projectsDir for all `*.jsonl` files.
 *  2. Keep only files whose mtime is within `config.lookbackMs` (the rate window)
 *     or STATE_LOOKBACK_MS (turn-state classification) of `now`.
 *  3. Read the tail of each — the full `config.tailBytes` inside the rate
 *     lookback, a smaller STATE_TAIL_BYTES read beyond it (those files' token
 *     events would fall outside the rate window anyway) — parse assistant lines,
 *     tagging every entry with the file's session (`sessionOrigin(path).session`),
 *     and classify the turn state (`classifyTail`). A state-lane file whose
 *     mtime matches its `prevStates` entry (the previous snapshot's cache) is
 *     not read at all — its tail cannot have changed, so the cached state (or
 *     cached null) is reused. This is what keeps the leader's read volume
 *     O(recently-written files), not O(files touched in the last 35 min).
 *  4. For each file whose tail classified to a state — or that yielded ≥1 token
 *     event, degrading to 'unknown' (transcript format drift) — record a
 *     FileActivity for the ⭐️ live counts. Files with neither (journal.jsonl
 *     etc.) produce no activity. Every looked-at file lands in the returned
 *     `states` map (self-pruning: only paths within a lookback are re-emitted).
 *
 * Session-agnostic: it doesn't need to know which session is "current" — the caller
 * matches its own session_id against the per-session rates. Never throws: unreadable
 * files / dirs are skipped and yield nothing.
 */
export const gatherEntries = async (
  config: Config,
  now: number,
  prevStates: Record<string, CachedTailState> = {},
): Promise<{ entries: TokenEntry[]; files: FileActivity[]; states: Record<string, CachedTailState> }> => {
  const paths = await walkJsonl(config.projectsDir);
  const states: Record<string, CachedTailState> = {};

  const perFile = await Promise.all(
    paths.map(async (path): Promise<{ entries: TokenEntry[]; file: FileActivity | null }> => {
      try {
        const { mtimeMs } = await stat(path);
        const age = now - mtimeMs;
        if (age > config.lookbackMs && age > STATE_LOOKBACK_MS) return { entries: [], file: null };

        const origin = sessionOrigin(path);
        const rateFresh = age <= config.lookbackMs;

        let entries: TokenEntry[] = [];
        let state: TurnState | null;
        let stateAtMs: number | null;
        const cached = prevStates[path];
        const cachedComplete =
          cached !== undefined &&
          (cached.state === null
            ? cached.stateAtMs === null
            : typeof cached.stateAtMs === 'number' && Number.isFinite(cached.stateAtMs));
        if (!rateFresh && cachedComplete && cached.mtimeMs === mtimeMs) {
          state = cached.state; // unchanged since last classified — skip the read
          stateAtMs = cached.stateAtMs;
        } else {
          const text = await readTail(path, rateFresh ? config.tailBytes : STATE_TAIL_BYTES);
          entries = rateFresh
            ? parseTranscriptText(text, origin.session, {
                includeCache: config.includeCache,
                effectiveRate: config.effectiveRate,
              })
            : [];
          const classified = classifyTailState(text);
          if (classified === null) {
            state = entries.length > 0 ? 'unknown' : null;
          } else {
            // A live-looking state without a usable event clock cannot safely use
            // the long corpse TTL. Keep ended terminal; degrade other states to
            // the short mtime-based format-drift lane.
            state = classified.atMs === null && classified.state !== 'ended' ? 'unknown' : classified.state;
          }
          // Clamp future/skewed row and file times to this scan's clock. Missing
          // timestamps and format-drift states retain the short mtime fallback.
          stateAtMs = state === null ? null : Math.min(classified?.atMs ?? mtimeMs, mtimeMs, now);
        }
        states[path] = { mtimeMs, state, stateAtMs };
        const file = state === null ? null : { ...origin, mtimeMs, state, stateAtMs: stateAtMs ?? mtimeMs };
        return { entries, file };
      } catch {
        return { entries: [], file: null };
      }
    }),
  );

  return {
    entries: perFile.flatMap((p) => p.entries),
    files: perFile.flatMap((p) => (p.file ? [p.file] : [])),
    states,
  };
};
