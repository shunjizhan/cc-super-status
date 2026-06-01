#!/usr/bin/env bun
// Impure entry point — the binary Claude Code runs as its statusLine.command.
//
// Everything is wrapped in try/catch: on ANY failure we degrade to the raw
// ccusage line (if we managed to read one) or an empty string. This process
// must NEVER throw or print a stack trace, since its stdout becomes the
// user's status line.

import type { Config, StatuslineInput } from './src/types';
import { getCcusageLine } from './src/ccusage';
import { gatherEntries } from './src/transcripts';
import { buildStatusline } from './src/buildStatusline';

const main = async (): Promise<void> => {
  const raw = await Bun.stdin.text();

  let input: StatuslineInput;
  try {
    input = JSON.parse(raw) as StatuslineInput;
  } catch {
    input = {};
  }

  const now = Date.now();

  // Positive finite number from env, else fallback (rejects "0", negatives, and non-numbers).
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const windowSec = num(process.env.CCSS_WINDOW, 120);
  const config: Config = {
    quota: num(process.env.CCSS_QUOTA, 125),
    windowSec,
    cells: 10,
    lookbackMs: windowSec * 1000 + 60_000,
    tailBytes: 1_048_576,
    projectsDir: `${process.env.HOME}/.claude/projects`,
  };

  // ccusage is launched first (it's the costliest step and the degrade target);
  // capture the raw line so the catch handler can fall back to it.
  let ccusageLine: string | null = null;
  try {
    ccusageLine = await getCcusageLine(raw, 3000).catch(() => null);

    const entries = await gatherEntries(
      config,
      input.transcript_path,
      input.session_id,
      now,
    ).catch(() => []);

    process.stdout.write(buildStatusline({ input, ccusageLine, entries, now, config }));
  } catch {
    process.stdout.write(ccusageLine ?? '');
  }
};

main().catch(() => {
  // Absolute last resort — never surface an error to the status line.
  process.stdout.write('');
});
