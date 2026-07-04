// Where cross-session coordination files live (claim, snapshot, limits, ccusage line).
// Defaults to the OS temp dir; `CCSS_STATE_DIR` overrides it — handy for relocating
// state off a noisy tmpfs, and the seam tests use to avoid touching the live files.

import { tmpdir } from 'node:os';

/** Directory holding all `ccss-*` shared-state files. */
export const stateDir = (): string => {
  const override = process.env.CCSS_STATE_DIR?.trim();
  return override && override.length > 0 ? override : tmpdir();
};
