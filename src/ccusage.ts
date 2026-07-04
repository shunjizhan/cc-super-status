// 🔥 / 💰 (block + today) data: wraps the `ccusage statusline` CLI.
//
// ccusage has no JS library API and a full recompute takes seconds, so it must never
// sit on a render path. Instead ONE detached, never-killed job recomputes it in the
// background and writes a single machine-wide line file; every tick just reads that
// file. See src/types.ts for the contract and CLAUDE.md for the invariants.

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { CcusageData, Config } from './types';
import { stateDir } from './paths';

/**
 * Parse a single `ccusage statusline` output line into structured cost data.
 *
 * Example line:
 *   "🤖 Opus 4.8 (1M context) | 💰 $-0.00 session / $313.92 today / $15.21 block (4h 15m left) | 🔥 $21.01/hr | 🧠 66,429 (7%)"
 *
 * Returns null if the cost segment does not match.
 */
export const parseCcusage = (line: string): CcusageData | null => {
  const costMatch = line.match(
    /\$(-?[0-9.]+) session \/ \$(-?[0-9.]+) today \/ \$(-?[0-9.]+) block \(([^)]*)\)/,
  );
  if (!costMatch) return null;

  const [, sessionStr, todayStr, blockStr, timeLeftRaw] = costMatch;

  const burnMatch = line.match(/🔥\s*([^|]+?)\s*(?:\||$)/);
  const burn = burnMatch?.[1]?.trim() ?? '';

  const timeLeft = timeLeftRaw.replace(/ left$/, '');

  return {
    session: Number(sessionStr),
    today: Number(todayStr),
    block: Number(blockStr),
    burn,
    timeLeft,
  };
};

/**
 * ccusage's OWN output-cache expiry, in seconds (`--refresh-interval`). Its default
 * is 1s; we set 10s so if a second job ever starts soon after one finished it can
 * hit ccusage's cache instead of recomputing. Distinct from `Config.ccusageRefreshSec`,
 * which is how stale OUR line may get before we ask ccusage for a fresh one at all.
 */
const CCUSAGE_CLI_REFRESH = '10';

/** How stale the shared line may be and still render (10 minutes, absolute ceiling). */
const LAST_GOOD_MAX_AGE_MS = 600_000;

/**
 * A job marker older than this is treated as a dead job, so a new one may spawn. A
 * real recompute finishes in ~4s (≤~11s under disk contention) and removes its own
 * marker; 30s means "this one crashed without cleaning up".
 */
const JOB_MAX_AGE_MS = 30_000;

/** Parse a ccusage time-left string ("4h 15m", "45m", "1h") into ms; null if unparseable. */
const parseTimeLeftMs = (timeLeft: string): number | null => {
  const m = timeLeft.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
};

/**
 * Whether a cached ccusage line, `ageMs` old, still describes the CURRENT 5-hour
 * block — i.e. its own "(X left)" outlives its age. Once that block has reset, the
 * line's block-$ (and the ⚡ fallback lane derived from it) point at a finished block
 * and would show quota nearly exhausted when the user in fact has a fresh block — a
 * wrong-direction render, worse than dropping the segments. Costs/burn merely
 * under-report with age, which is acceptable. Lines without a parseable cost segment
 * are usable (nothing block-scoped in them to misread).
 */
export const staleLineStillCurrent = (line: string, ageMs: number): boolean => {
  const parsed = parseCcusage(line);
  if (parsed === null) return true;
  const leftMs = parseTimeLeftMs(parsed.timeLeft);
  return leftMs === null ? true : ageMs < leftMs;
};

// ── Shared files (machine-wide, in the state dir) ───────────────────────────────
// The recomputed line every session reads; the stdin payload the job runs against;
// and the marker that rate-limits spawning to one job at a time.
const ccusageLinePath = (): string => `${stateDir()}/ccss-ccusage.line`;
const ccusagePayloadPath = (): string => `${stateDir()}/ccss-ccusage.payload`;
const ccusageJobPath = (): string => `${stateDir()}/ccss-ccusage.job`;

/**
 * Resolve how to invoke `ccusage statusline`, fastest-first:
 *   1. a `ccusage` on PATH (Bun.which),
 *   2. bun's canonical global bin (`~/.bun/bin/ccusage`) — `bun install -g` lands here
 *      but the dir is often not on PATH, so we check it explicitly,
 *   3. `bunx ccusage` — always works, but re-resolves the package each run.
 * Returned as an argv array. Runs only inside the detached job, so the node-stub /
 * native-binary distinction no longer matters (nothing kills it, nothing pipes it).
 */
const resolveCcusageCmd = (): string[] => {
  const args = ['statusline', '--refresh-interval', CCUSAGE_CLI_REFRESH];

  const onPath = Bun.which('ccusage');
  if (onPath) return [onPath, ...args];

  const bunGlobal = `${process.env.HOME}/.bun/bin/ccusage`;
  if (existsSync(bunGlobal)) return [bunGlobal, ...args];

  return ['bunx', 'ccusage', ...args];
};

/** File mtime as epoch ms, or null if the file is absent / unreadable. */
const mtimeMs = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Read the shared ccusage line if it exists, is fresher than 10 minutes, and predates
 * no 5-hour block reset. Returns null otherwise (caller drops 🔥/💰 for this tick).
 * Never throws.
 */
export const readCcusageLine = async (now: number): Promise<string | null> => {
  const mt = await mtimeMs(ccusageLinePath());
  if (mt === null) return null;
  const ageMs = now - mt;
  if (ageMs > LAST_GOOD_MAX_AGE_MS) return null;
  try {
    const line = (await Bun.file(ccusageLinePath()).text()).trim();
    if (line.length === 0) return null;
    return staleLineStillCurrent(line, ageMs) ? line : null;
  } catch {
    return null;
  }
};

/** POSIX single-quote a string for safe interpolation into an `sh -c` command. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Paths the job reads/writes — grouped so `buildJobScript` stays pure and testable. */
interface JobPaths {
  cmd: string[]; // resolved ccusage argv
  payload: string; // stdin JSON file
  tmp: string; // pid-unique stdout staging file
  line: string; // shared output line (rename target)
  marker: string; // job marker to remove on completion
}

/**
 * Decide whether to spawn a fresh recompute: only when the shared line is older than
 * the refresh interval AND no job is already running (its marker fresher than
 * JOB_MAX_AGE_MS). Ages are ms, `Infinity` for an absent file. Pure.
 */
export const shouldSpawnJob = (lineAgeMs: number, jobAgeMs: number, refreshMs: number): boolean =>
  lineAgeMs > refreshMs && jobAgeMs > JOB_MAX_AGE_MS;

/**
 * The `sh -c` script the detached job runs. Reads the payload on stdin, writes stdout
 * to `tmp`, and — only if `tmp` ended up non-empty — renames it over `line` (atomic on
 * one filesystem). Whatever happens, `tmp` and the marker are removed. So a failed or
 * empty ccusage run leaves the previous good `line` untouched, and the marker always
 * clears for the next spawn. Pure.
 */
export const buildJobScript = ({ cmd, payload, tmp, line, marker }: JobPaths): string => {
  const invocation = cmd.map(shq).join(' ');
  return (
    `${invocation} < ${shq(payload)} > ${shq(tmp)} && [ -s ${shq(tmp)} ] && mv -f ${shq(tmp)} ${shq(line)}` +
    `; rm -f ${shq(tmp)} ${shq(marker)}`
  );
};

/**
 * Spawn the detached ccusage recompute when `shouldSpawnJob` says to. Best-effort,
 * never throws; returns whether it spawned. The job is unref'd with detached stdio, so
 * nothing this process does can kill it or truncate its output: every recompute that
 * starts also lands.
 */
export const maybeSpawnCcusageJob = async (
  payloadJson: string,
  now: number,
  config: Config,
): Promise<boolean> => {
  try {
    const lineMt = await mtimeMs(ccusageLinePath());
    const jobMt = await mtimeMs(ccusageJobPath());
    const lineAge = lineMt === null ? Infinity : now - lineMt;
    const jobAge = jobMt === null ? Infinity : now - jobMt;
    if (!shouldSpawnJob(lineAge, jobAge, config.ccusageRefreshSec * 1000)) return false;

    const paths: JobPaths = {
      cmd: resolveCcusageCmd(),
      payload: ccusagePayloadPath(),
      marker: ccusageJobPath(),
      line: ccusageLinePath(),
      // Same dir as `line` so the final `mv` is a same-filesystem (atomic) rename.
      tmp: `${stateDir()}/ccss-ccusage.${process.pid}.tmp`,
    };

    await Bun.write(paths.payload, payloadJson);
    await Bun.write(paths.marker, String(process.pid)); // touch — mtime gates the next spawn

    const proc = Bun.spawn(['sh', '-c', buildJobScript(paths)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    proc.unref();
    return true;
  } catch {
    return false; // best-effort — a failed spawn just means the next tick retries.
  }
};
