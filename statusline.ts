#!/usr/bin/env bun
// Impure entry point — the binary Claude Code runs as its statusLine.command.
//
// Thin shell: read stdin, resolve this generation's shared snapshot (leader walks &
// publishes; followers read), render, print. Everything is wrapped so this process
// NEVER throws or prints a stack trace — its stdout becomes the user's status line.
// On total failure we degrade to the snapshot's raw ccusage line (if we got one) or ''.

import type { SharedSnapshot, StatuslineInput } from './src/types';
import { parseConfig } from './src/config';
import { barScaleForMode, detectAccountUuid, detectRateLimitTier } from './src/plan';
import { resolveSnapshot } from './src/shared';
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
  // ⚡ bar width: CCSS_BAR_MODE (max/default/auto) picks the scale, else it auto-detects
  // from the plan tier in ~/.claude.json (Max 20x → 4×); an explicit CCSS_CELLS overrides
  // both. Render-only (cfgKey excludes cells), so this per-pane read never fragments the
  // shared snapshot. See src/plan.ts.
  const config = parseConfig(process.env, barScaleForMode(process.env.CCSS_BAR_MODE, detectRateLimitTier()));
  // Scopes the shared rate-limit merge (see src/shared.ts): the merge only ratchets
  // forward, which is right within an account and wrong across a switch, so the stored
  // merge is stamped with this and discarded when it names someone else.
  const account = detectAccountUuid();

  let shared: SharedSnapshot | undefined;
  try {
    shared = await resolveSnapshot(config, input, raw, now, account);
    process.stdout.write(buildStatusline({ input, shared, now, config }));
  } catch {
    process.stdout.write(shared?.ccusage ?? '');
  }
};

main()
  .catch(() => {
    // Absolute last resort — never surface an error to the status line.
    process.stdout.write('');
  })
  .finally(() => {
    // Exit explicitly so a stray handle can't keep this render process alive after the
    // line is written (the detached ccusage job is unref'd and outlives us on its own).
    process.exit(0);
  });
