import { existsSync } from 'node:fs';

import type { CcusageData } from './types';

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
 * Resolve how to invoke ccusage, fastest-first:
 *   1. a `ccusage` on PATH (Bun.which),
 *   2. bun's canonical global bin (`~/.bun/bin/ccusage`) — `bun install -g` lands
 *      here but the dir is often not on PATH, so we check it explicitly,
 *   3. `bunx ccusage` — always works, but re-resolves the package each run.
 */
const resolveCcusageCmd = (): string[] => {
  const onPath = Bun.which('ccusage');
  if (onPath) return [onPath, 'statusline'];

  const bunGlobal = `${process.env.HOME}/.bun/bin/ccusage`;
  if (existsSync(bunGlobal)) return [bunGlobal, 'statusline'];

  return ['bunx', 'ccusage', 'statusline'];
};

/**
 * Run `ccusage statusline`, feeding `stdinJson` on the child's stdin, and
 * return the trimmed stdout. Prefers a globally installed `ccusage` binary,
 * falling back to `bunx ccusage`.
 *
 * Never throws: returns null on timeout, non-zero exit, or any error.
 */
export const getCcusageLine = async (
  stdinJson: string,
  timeoutMs: number,
): Promise<string | null> => {
  const cmd = resolveCcusageCmd();

  try {
    const proc = Bun.spawn(cmd, {
      stdin: new TextEncoder().encode(stdinJson),
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const timer = setTimeout(() => proc.kill(), timeoutMs);

    try {
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) return null;
      return stdout.trim();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};
