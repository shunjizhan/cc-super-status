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

import type { ActiveCounts, Config, FileActivity, TokenEntry } from './types';

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

/**
 * Count the sessions and sub-agents that are active *right now* — i.e. whose
 * transcript was written within `activeMs`. Pure: distinct `session` keys →
 * active sessions (a session groups with its own sub-agents, counted once);
 * distinct non-null `subagent` keys → active sub-agents. This is deliberately
 * decoupled from the token-rate window: it tracks live work (file mtime), so it
 * decays within `activeMs` of an agent going quiet, not within the rate window.
 */
export const countActive = (
  files: FileActivity[],
  now: number,
  activeMs: number,
): ActiveCounts => {
  const sessions = new Set<string>();
  const subagents = new Set<string>();
  for (const f of files) {
    if (now - f.mtimeMs > activeMs) continue; // touched too long ago → not live
    sessions.add(f.session);
    if (f.subagent !== null) subagents.add(f.subagent);
  }
  return { sessions: sessions.size, subagents: subagents.size };
};

/**
 * Gather token events and per-file activity from every recently-modified
 * transcript under `config.projectsDir`.
 *
 * Steps (impure — filesystem I/O):
 *  1. Walk projectsDir for all `*.jsonl` files.
 *  2. Keep only files whose mtime is within `config.lookbackMs` of `now`.
 *  3. Read the tail (`config.tailBytes`) of each and parse assistant lines, tagging
 *     every entry with the file's session (`sessionOrigin(path).session`).
 *  4. For each file that yielded ≥1 token event (a real assistant transcript —
 *     excludes journal.jsonl etc.), record a FileActivity (session, subagent,
 *     mtime) for the ⭐️ live counts.
 *
 * Session-agnostic: it doesn't need to know which session is "current" — the caller
 * matches its own session_id against the per-session rates. Never throws: unreadable
 * files / dirs are skipped and yield nothing.
 */
export const gatherEntries = async (
  config: Config,
  now: number,
): Promise<{ entries: TokenEntry[]; files: FileActivity[] }> => {
  const paths = await walkJsonl(config.projectsDir);

  const perFile = await Promise.all(
    paths.map(async (path): Promise<{ entries: TokenEntry[]; file: FileActivity | null }> => {
      try {
        const { mtimeMs } = await stat(path);
        if (now - mtimeMs > config.lookbackMs) return { entries: [], file: null };

        const origin = sessionOrigin(path);
        const text = await readTail(path, config.tailBytes);
        const entries = parseTranscriptText(text, origin.session, {
          includeCache: config.includeCache,
          effectiveRate: config.effectiveRate,
        });
        // Only real assistant transcripts (≥1 token event) count as activity.
        const file = entries.length > 0 ? { ...origin, mtimeMs } : null;
        return { entries, file };
      } catch {
        return { entries: [], file: null };
      }
    }),
  );

  return {
    entries: perFile.flatMap((p) => p.entries),
    files: perFile.flatMap((p) => (p.file ? [p.file] : [])),
  };
};
