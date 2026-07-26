// Cross-session coordination: one session per ~5s generation ("the leader") does the
// expensive global work — the transcript walk + rate-limit merge — and freezes it into
// a SharedSnapshot on disk. Every other open session ("a follower") reads that snapshot
// and renders byte-identical globals, so multiple panes agree instead of each sampling
// the world on its own schedule. Nobody waits on anything slow. See README
// "Multi-session architecture" and src/types.ts for the contract.

import { rename, stat } from 'node:fs/promises';

import type { CachedTailState, Config, MergedRateLimits, RateLimitWindow, SharedSnapshot, StatuslineInput, StoredLimits } from './types';
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
 * (the rate math and the active-count window). Render-only prefs (weekly, cells, layers,
 * quota estimate) are applied per-pane from the same snapshot, so they're excluded: panes
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

/**
 * Merge two rate-limit windows to the fresher reading. Equal resets_at → higher used% (the
 * more advanced reading of the same window). Different resets_at → the later one wins ONLY
 * once the earlier has actually expired, because that is the only way a window rolls
 * forward; before then, a reading claiming a *different* future window did not come from
 * this account's current window at all, and the still-current one wins.
 *
 * That expiry condition is what stops a pane left signed in to a previous account from
 * re-pinning the shared bars. Claude Code fills stdin `rate_limits` from a process-local
 * variable it only refreshes from API response headers, so a pane that has made no request
 * since someone switched accounts keeps shipping the OLD account's window — with its own,
 * typically later, resets_at — on every tick. Scoping the stored file by account (see
 * `parseStoredLimits`) evicts that account's *stored* merge but cannot filter its live
 * contributions; this does.
 */
const mergeWindow = (
  x: RateLimitWindow | undefined,
  y: RateLimitWindow | undefined,
  now: number,
): RateLimitWindow | undefined => {
  if (!x) return y;
  if (!y) return x;
  const rx = x.resets_at ?? -Infinity;
  const ry = y.resets_at ?? -Infinity;
  if (rx !== ry) {
    // resets_at is epoch SECONDS; `now` is epoch ms. A window with no resets_at counts as
    // long expired, so a reading that carries one always beats one that doesn't.
    const earlierExpired = Math.min(rx, ry) * 1000 <= now;
    const later = rx > ry ? x : y;
    const earlier = rx > ry ? y : x;
    return earlierExpired ? later : earlier;
  }
  // Same window (equal reset) → the higher used% is the more advanced (monotone) reading.
  return (x.used_percentage ?? -Infinity) >= (y.used_percentage ?? -Infinity) ? x : y;
};

/**
 * Merge rate-limit views across sessions. An idle session's stale reading can't drag
 * the shared bars back: within a window used% only rises (higher wins), and a window
 * rollover pushes resets_at forward once the old window expires, so the merge tracks the
 * true account state as the leading session sees it. Returns null when neither side has
 * any window.
 *
 * An account switch defeats that ratchet on both branches at once, and needs BOTH halves of
 * the defence: `parseStoredLimits` evicts the previous account's stored merge, and
 * `mergeWindow`'s expiry condition rejects its still-live contributions from panes left
 * signed in to it. Scoping alone is not enough — the stored file can be re-poisoned under
 * the new stamp within one tick.
 */
export const mergeRateLimits = (
  a: MergedRateLimits | null | undefined,
  b: MergedRateLimits | null | undefined,
  now: number,
): MergedRateLimits | null => {
  const five_hour = mergeWindow(a?.five_hour, b?.five_hour, now);
  const seven_day = mergeWindow(a?.seven_day, b?.seven_day, now);
  if (!five_hour && !seven_day) return null;
  return { ...(five_hour && { five_hour }), ...(seven_day && { seven_day }) };
};

/**
 * Parse + validate the stored merge (`ccss-limits.json`) as this account's. Returns null on
 * bad JSON, a stamp naming a different account, or no usable window — in every case the
 * caller reseeds from live stdin instead of inheriting the stored windows. Reuses
 * `mergeRateLimits` as the shape-tolerant validator, which also strips `account` back off,
 * so the account never reaches the snapshot or the render. Pure.
 *
 * Both merge branches leak across a switch (five_hour via later-resets_at, seven_day via the
 * equal-resets_at used% tie) and the stored file carries nothing else that could tell a stale
 * contributor from a new account, so eviction has to be by identity. This is only half the
 * defence — it clears the previous account's *stored* merge, while `mergeWindow`'s expiry
 * condition is what keeps that account's live contributors from writing it straight back.
 *
 * A missing stamp normalises to null, so a legacy file is invalidated exactly once for any
 * real account, while a null account (API-key user, or an unreadable ~/.claude.json) reads a
 * coherent bucket of its own rather than inheriting a subscriber's quota.
 */
export const parseStoredLimits = (
  text: string,
  account: string | null,
  now: number,
): MergedRateLimits | null => {
  try {
    const o = JSON.parse(text) as StoredLimits;
    if (!o || typeof o !== 'object') return null;
    if ((o.account ?? null) !== account) return null;
    return mergeRateLimits(o, null, now);
  } catch {
    return null;
  }
};

/**
 * The account stamp on the stored merge, or null when the file is unparseable or unstamped.
 * Used only to refuse an overwrite: a tick that cannot identify itself must not replace a
 * bucket that names a real account (see `contributeLimits`). Pure.
 */
export const storedLimitsAccount = (text: string): string | null => {
  try {
    const o = JSON.parse(text) as StoredLimits;
    return (o && typeof o === 'object' ? o.account : null) ?? null;
  } catch {
    return null;
  }
};

/**
 * Assemble the snapshot the leader freezes. Pure: rates (per session) + active counts,
 * plus the already-validated merged limits and ccusage line passed in. `asOf` is the
 * generation clock every reader uses to judge freshness. `states` is the walk's
 * tail-state cache, carried so the next generation can skip unchanged files.
 */
export const buildSnapshot = (
  entries: Parameters<typeof computeRatesBySession>[0],
  files: Parameters<typeof countActive>[0],
  now: number,
  config: Config,
  limits: MergedRateLimits | null,
  ccusageLine: string | null,
  states: Record<string, CachedTailState> = {},
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
    states,
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

/**
 * The previous generation's tail-state cache, read from the snapshot file
 * REGARDLESS of freshness — each cache entry is self-validating (keyed by the
 * file's mtime), so even a stale snapshot's cache safely skips unchanged reads.
 */
const readPrevStates = async (config: Config): Promise<Record<string, CachedTailState>> => {
  try {
    const snap = parseSnapshot(await Bun.file(snapshotPath(config)).text());
    return snap?.states ?? {};
  } catch {
    return {};
  }
};

/** Raw contents of the shared limits file, or null if absent / unreadable. */
const readLimitsText = async (): Promise<string | null> => {
  try {
    return await Bun.file(limitsPath()).text();
  } catch {
    return null;
  }
};

/**
 * Read the machine-wide merged rate-limit windows for `account`, or null if the file is
 * absent / unreadable / holds another account's merge (see `parseStoredLimits`).
 */
const readLimits = async (account: string | null, now: number): Promise<MergedRateLimits | null> => {
  const text = await readLimitsText();
  return text === null ? null : parseStoredLimits(text, account, now);
};

/**
 * Fold this session's stdin rate-limit view into the shared merge (monotone, so a
 * stale contributor never regresses it) and stamp it with the signed-in account, so the
 * next reader can tell whose ratchet it is. Skips the write when nothing changes, to
 * avoid rename churn across many panes each tick — a foreign stored merge reads as null,
 * so the first tick after a switch always differs and reseeds. Best-effort.
 *
 * A tick that could not read an account leaves a stamped bucket alone entirely. Without an
 * identity it cannot tell "my account" from "someone else's", and since one file holds one
 * bucket, writing a null stamp would evict a real account's accumulated cross-pane maximum
 * on the strength of a single pane's view — the backward jump the ratchet exists to prevent.
 */
const contributeLimits = async (
  mine: MergedRateLimits | null | undefined,
  account: string | null,
  now: number,
): Promise<void> => {
  if (!mine || (!mine.five_hour && !mine.seven_day)) return; // API-key user / no data → nothing to add
  const text = await readLimitsText();
  if (account === null && text !== null && storedLimitsAccount(text) !== null) return;

  const current = text === null ? null : parseStoredLimits(text, account, now);
  const merged = mergeRateLimits(current, mine, now);
  if (merged && JSON.stringify(merged) !== JSON.stringify(current)) {
    await atomicWrite(limitsPath(), JSON.stringify({ account, ...merged }));
  }
};

/**
 * Resolve the SharedSnapshot this tick renders from, doing the least work its role
 * allows:
 *   - every tick contributes its own rate-limit view to the shared merge, scoped to
 *     `account` (the signed-in oauthAccount.accountUuid) so a switch resets the ⚡ bars
 *     instead of inheriting the previous account's ratchet;
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
  account: string | null,
): Promise<SharedSnapshot> => {
  await contributeLimits(input.rate_limits, account, now);

  const role = decideRole(await statMtime(claimPath()), now, LEASE_MS);

  if (role === 'follower') {
    const snap = await readSnapshot(config, now);
    if (snap) return snap;
    // No usable snapshot (none yet, or leadership lapsed) → build locally, don't publish.
  } else {
    await claimLeadership(now);
  }

  const [{ entries, files, states }, limits, ccusageLine] = await Promise.all([
    readPrevStates(config).then((prev) => gatherEntries(config, now, prev)),
    readLimits(account, now),
    readCcusageLine(now),
  ]);
  if (role === 'leader') await maybeSpawnCcusageJob(rawStdin, now, config);

  const snap = buildSnapshot(entries, files, now, config, limits, ccusageLine, states);
  if (role === 'leader') await writeSnapshot(snap, config);
  return snap;
};
