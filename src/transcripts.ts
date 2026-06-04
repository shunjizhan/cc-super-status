// ⭐️ transcript gathering: read JSONL transcripts on disk → TokenEntry[].
//
// This is the only impure piece of the rate pipeline (filesystem I/O). It walks
// the projects root for recently-modified *.jsonl transcripts, reads the tail of
// each, and extracts one TokenEntry per assistant message that carries usage.
//
// "current" entries belong to the active session: its main transcript
// (input.transcript_path) plus any subagent transcripts living under
// `<...>/<session_id>/subagents/*.jsonl`. Everything else is non-current.
//
// See src/types.ts for the authoritative contract. Dedup / windowing / rate math
// all live downstream in src/rate.ts — this module only produces raw entries.

import { readdir, stat } from 'node:fs/promises';

import type { Config, TokenEntry } from './types';

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
 * Parse the assistant lines of one transcript's text into TokenEntry[].
 *
 * `opts` (includeCache + effectiveRate) is forwarded to `tokenCount`, which bakes
 * the per-component weighting into each entry's `tok`. Downstream — dedup,
 * windowing, the per-second divide — never sees the split.
 */
export const parseTranscriptText = (
  text: string,
  current: boolean,
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

    entries.push({ id, tok, ts, current });
  }

  return entries;
};

/**
 * Decide whether a transcript path belongs to the current session.
 *  - the main transcript itself (`transcriptPath`), or
 *  - anything under a `<session_id>/subagents/` directory.
 */
const isCurrent = (
  path: string,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
): boolean => {
  if (transcriptPath !== undefined && path === transcriptPath) return true;
  if (sessionId !== undefined && path.includes(`/${sessionId}/subagents/`)) return true;
  return false;
};

/**
 * Gather TokenEntry[] from every recently-modified transcript under
 * `config.projectsDir`.
 *
 * Steps (impure — filesystem I/O):
 *  1. Walk projectsDir for all `*.jsonl` files.
 *  2. Keep only files whose mtime is within `config.lookbackMs` of `now`.
 *  3. Read the tail (`config.tailBytes`) of each and parse assistant lines.
 *  4. Tag each entry current/non-current per `isCurrent`.
 *
 * Never throws: unreadable files / dirs are skipped and yield no entries.
 */
export const gatherEntries = async (
  config: Config,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  now: number,
): Promise<TokenEntry[]> => {
  const paths = await walkJsonl(config.projectsDir);

  const perFile = await Promise.all(
    paths.map(async (path): Promise<TokenEntry[]> => {
      try {
        const { mtimeMs } = await stat(path);
        if (now - mtimeMs > config.lookbackMs) return [];

        const text = await readTail(path, config.tailBytes);
        return parseTranscriptText(text, isCurrent(path, transcriptPath, sessionId), {
          includeCache: config.includeCache,
          effectiveRate: config.effectiveRate,
        });
      } catch {
        return [];
      }
    }),
  );

  return perFile.flat();
};
