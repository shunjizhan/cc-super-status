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

/** Shape of the transcript JSONL lines we care about (everything optional/loose). */
interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

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
 * `includeCache` controls whether cache tokens (cache_creation + cache_read)
 * are counted on top of input + output. With it on (the default), each entry's
 * `tok` matches ccusage's total-token definition.
 */
export const parseTranscriptText = (
  text: string,
  current: boolean,
  includeCache: boolean,
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

    let tok = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    if (includeCache) {
      tok += (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    }
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
        return parseTranscriptText(
          text,
          isCurrent(path, transcriptPath, sessionId),
          config.includeCache,
        );
      } catch {
        return [];
      }
    }),
  );

  return perFile.flat();
};
