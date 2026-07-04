// Cross-session coordination: one session per ~5s generation ("the leader") does the
// expensive global work — the transcript walk + rate-limit merge — and freezes it into
// a SharedSnapshot on disk. Every other open session ("a follower") reads that snapshot
// and renders byte-identical globals, so multiple panes agree instead of each sampling
// the world on its own schedule. Nobody waits on anything slow. See README
// "Multi-session architecture" and src/types.ts for the contract.

import { rename, stat } from 'node:fs/promises';

import type { Config, MergedRateLimits, RateLimitWindow, SharedSnapshot, StatuslineInput } from './types';
import { computeRatesBySession } from './rate';
import { countActive, gatherEntries } from './transcripts';
import { maybeSpawnCcusageJob, readCcusageLine } from './ccusage';
import { stateDir } from './paths';

/** Snapshot schema version — a reader rejects any other and rebuilds locally. */
const SNAPSHOT_VERSION = 1;

/**
 * Leadership lease length, ms. The claim file's mtime IS the lease: older than this
 * ⇒ "nobody's leading, take over". Also the generation length — a fresh leader every
 * ~5s refreshes the snapshot. A crashed leader ages out within one lease.
 */
const LEASE_MS = 5_000;

/**
 * How stale a snapshot may be and still be served, ms. Two lease lengths, so a single
 * missed generation (a leader that claimed then died before writing) still renders the
 * previous coherent snapshot rather than flickering to a local one. Beyond this,
 * followers fall back to a local walk.
 */
const SNAP_MAX_AGE_MS = 2 * LEASE_MS;

// ── Pure decision helpers ───────────────────────────────────────────────────────

/**
 * Config fingerprint — only the fields that change what the SHARED snapshot contains
 * (the rate math and the active-count window). Render-only prefs (weekly, cells, quota
 * estimate) are applied per-pane from the same snapshot, so they're excluded: panes
 * that differ only in those still share one snapshot. A snapshot built under a
 * different fingerprint is ignored (also scopes the snapshot's filename).
 */
export const cfgKey = (config: Config): string =>
  `${config.windowSec}-${config.activeWindowSec}-${config.includeCache ? 1 : 0}-${config.effectiveRate ? 1 : 0}`;

/**
 * Whether this tick should lead: no claim yet (null) or the lease has expired. A rare
 * tie (two ticks both see it stale) just means two leaders that generation — wasteful
 * (two walks) but not incorrect, since each writes a valid snapshot for the same data.
 */
export const decideRole = (
  claimMtimeMs: number | null,
  now: number,
  ttlMs: number,
): 'leader' | 'follower' => (claimMtimeMs === null || now - claimMtimeMs >= ttlMs ? 'leader' : 'follower');

/** Merge two rate-limit windows to the fresher reading: later resets_at wins; tie → higher used%. */
const mergeWindow = (
  x: RateLimitWindow | undefined,
  y: RateLimitWindow | undefined,
): RateLimitWindow | undefined => {
  if (!x) return y;
  if (!y) return x;
  const rx = x.resets_at ?? -Infinity;
  const ry = y.resets_at ?? -Infinity;
  if (rx > ry) return x;
  if (ry > rx) return y;
  // Same window (equal reset) → the higher used% is the more advanced (monotone) reading.
  return (x.used_percentage ?? -Infinity) >= (y.used_percentage ?? -Infinity) ? x : y;
};

/**
 * Merge rate-limit views across sessions. An idle session's stale reading can't drag
 * the shared bars back: within a window used% only rises (higher wins), and a window
 * rollover pushes resets_at forward (later wins), so the merge tracks the true account
 * state as the leading session sees it. Returns null when neither side has any window.
 */
export const mergeRateLimits = (
  a: MergedRateLimits | null | undefined,
  b: MergedRateLimits | null | undefined,
): MergedRateLimits | null => {
  const five_hour = mergeWindow(a?.five_hour, b?.five_hour);
  const seven_day = mergeWindow(a?.seven_day, b?.seven_day);
  if (!five_hour && !seven_day) return null;
  return { ...(five_hour && { five_hour }), ...(seven_day && { seven_day }) };
};

/**
 * Assemble the snapshot the leader freezes. Pure: rates (per session) + active counts,
 * plus the already-validated merged limits and ccusage line passed in. `asOf` is the
 * generation clock every reader uses to judge freshness.
 */
export const buildSnapshot = (
  entries: Parameters<typeof computeRatesBySession>[0],
  files: Parameters<typeof countActive>[0],
  now: number,
  config: Config,
  limits: MergedRateLimits | null,
  ccusageLine: string | null,
): SharedSnapshot => {
  const { all, bySession } = computeRatesBySession(entries, now, config.windowSec * 1000);
  const counts = countActive(files, now, config.activeWindowSec * 1000);
  return {
    v: SNAPSHOT_VERSION,
    cfgKey: cfgKey(config),
    asOf: now,
    all,
    bySession,
    counts,
    limits,
    ccusage: ccusageLine,
  };
};

/** Parse + shape-validate snapshot JSON. Returns null on bad JSON, wrong version, or a missing field. */
export const parseSnapshot = (text: string): SharedSnapshot | null => {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    if (o.v !== SNAPSHOT_VERSION) return null;
    if (typeof o.cfgKey !== 'string' || typeof o.asOf !== 'number' || typeof o.all !== 'number') return null;
    if (!o.bySession || typeof o.bySession !== 'object') return null;
    if (!o.counts || typeof o.counts !== 'object') return null;
    return o as unknown as SharedSnapshot;
  } catch {
    return null;
  }
};

/** Whether a parsed snapshot matches this config and is within the freshness budget. */
export const snapshotUsable = (
  snap: SharedSnapshot,
  now: number,
  config: Config,
  ttlMs: number,
): boolean => snap.cfgKey === cfgKey(config) && now - snap.asOf < ttlMs;

// ── Impure filesystem I/O (thin, best-effort, never throws) ──────────────────────

const claimPath = (): string => `${stateDir()}/ccss-claim`;
const snapshotPath = (config: Config): string => `${stateDir()}/ccss-snap-${cfgKey(config)}.json`;
const limitsPath = (): string => `${stateDir()}/ccss-limits.json`;

/** Write `data` atomically: a pid-unique temp file renamed into place. Never throws. */
const atomicWrite = async (path: string, data: string): Promise<void> => {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, data);
    await rename(tmp, path);
  } catch {
    // best-effort — a failed write just costs coherence for a tick.
  }
};

/** File mtime as epoch ms, or null if absent / unreadable. */
const statMtime = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
};

/** Take (or renew) the leadership lease by stamping the claim file's mtime. */
const claimLeadership = async (now: number): Promise<void> => atomicWrite(claimPath(), String(now));

/** Publish the snapshot for this generation (atomic). */
export const writeSnapshot = async (snap: SharedSnapshot, config: Config): Promise<void> =>
  atomicWrite(snapshotPath(config), JSON.stringify(snap));

/** Read + validate the current snapshot for this config, or null if absent/stale/mismatched. */
const readSnapshot = async (config: Config, now: number): Promise<SharedSnapshot | null> => {
  try {
    const text = await Bun.file(snapshotPath(config)).text();
    const snap = parseSnapshot(text);
    if (snap && snapshotUsable(snap, now, config, SNAP_MAX_AGE_MS)) return snap;
    return null;
  } catch {
    return null;
  }
};

/** Read the machine-wide merged rate-limit windows, or null if none/unreadable. */
const readLimits = async (): Promise<MergedRateLimits | null> => {
  try {
    const o = JSON.parse(await Bun.file(limitsPath()).text()) as MergedRateLimits;
    return mergeRateLimits(o, null); // reuse the shape-tolerant merge as a validator
  } catch {
    return null;
  }
};

/**
 * Fold this session's stdin rate-limit view into the shared merge (monotone, so a
 * stale contributor never regresses it). Skips the write when nothing changes, to
 * avoid rename churn across many panes each tick. Best-effort.
 */
const contributeLimits = async (mine: MergedRateLimits | null | undefined): Promise<void> => {
  if (!mine || (!mine.five_hour && !mine.seven_day)) return; // API-key user / no data → nothing to add
  const current = await readLimits();
  const merged = mergeRateLimits(current, mine);
  if (merged && JSON.stringify(merged) !== JSON.stringify(current)) {
    await atomicWrite(limitsPath(), JSON.stringify(merged));
  }
};

/**
 * Resolve the SharedSnapshot this tick renders from, doing the least work its role
 * allows:
 *   - every tick contributes its own rate-limit view to the shared merge;
 *   - the leader walks transcripts, reads the merged limits + ccusage line, spawns the
 *     ccusage recompute if the line is stale, freezes a fresh snapshot, and writes it;
 *   - a follower reads the frozen snapshot (no walk) — a session simply absent from
 *     `bySession` is idle and correctly renders cur 0; only when NO usable snapshot
 *     exists does it fall back to a local walk (renders its own data, doesn't publish).
 * Never throws — every I/O helper degrades to null / no-op.
 */
export const resolveSnapshot = async (
  config: Config,
  input: StatuslineInput,
  rawStdin: string,
  now: number,
): Promise<SharedSnapshot> => {
  await contributeLimits(input.rate_limits);

  const role = decideRole(await statMtime(claimPath()), now, LEASE_MS);

  if (role === 'follower') {
    const snap = await readSnapshot(config, now);
    if (snap) return snap;
    // No usable snapshot (none yet, or leadership lapsed) → build locally, don't publish.
  } else {
    await claimLeadership(now);
  }

  const [{ entries, files }, limits, ccusageLine] = await Promise.all([
    gatherEntries(config, now),
    readLimits(),
    readCcusageLine(now),
  ]);
  if (role === 'leader') await maybeSpawnCcusageJob(rawStdin, now, config);

  const snap = buildSnapshot(entries, files, now, config, limits, ccusageLine);
  if (role === 'leader') await writeSnapshot(snap, config);
  return snap;
};
