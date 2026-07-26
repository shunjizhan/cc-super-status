import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { Config, FileActivity, MergedRateLimits, SharedSnapshot, StatuslineInput, StoredLimits, TokenEntry } from '../src/types';
import {
  buildSnapshot,
  cfgKey,
  decideRole,
  mergeRateLimits,
  parseSnapshot,
  parseStoredLimits,
  resolveSnapshot,
  snapshotUsable,
  storedLimitsAccount,
  writeSnapshot,
} from '../src/shared';

const NOW = 1_780_228_920_000; // 2026-05-31T12:02:00Z — same clock the e2e fixtures use

const baseConfig: Config = {
  quota: 125,
  windowSec: 120,
  activeWindowSec: 15,
  includeCache: true,
  effectiveRate: true,
  showWeekly: false,
  cells: 10,
  layers: 1,
  ccusageRefreshSec: 30,
  lookbackMs: 120 * 1000 + 60_000,
  tailBytes: 1_048_576,
  projectsDir: '/nonexistent',
};

describe('cfgKey', () => {
  test('is stable and ignores render-only prefs (weekly, cells, layers, quota)', () => {
    const k = cfgKey(baseConfig);
    expect(cfgKey({ ...baseConfig, showWeekly: true })).toBe(k);
    expect(cfgKey({ ...baseConfig, cells: 20 })).toBe(k);
    expect(cfgKey({ ...baseConfig, layers: 4 })).toBe(k); // plan scale is per-pane, not in the fingerprint
    expect(cfgKey({ ...baseConfig, quota: 999 })).toBe(k);
    expect(cfgKey({ ...baseConfig, ccusageRefreshSec: 60 })).toBe(k);
  });

  test('changes when any rate/count-affecting field changes', () => {
    const k = cfgKey(baseConfig);
    expect(cfgKey({ ...baseConfig, windowSec: 180 })).not.toBe(k);
    expect(cfgKey({ ...baseConfig, activeWindowSec: 30 })).not.toBe(k);
    expect(cfgKey({ ...baseConfig, includeCache: false })).not.toBe(k);
    expect(cfgKey({ ...baseConfig, effectiveRate: false })).not.toBe(k);
  });
});

describe('decideRole', () => {
  test('no claim → leader', () => {
    expect(decideRole(null, NOW, 5000)).toBe('leader');
  });

  test('expired lease → leader (boundary: exactly ttl old)', () => {
    expect(decideRole(NOW - 5000, NOW, 5000)).toBe('leader');
    expect(decideRole(NOW - 9000, NOW, 5000)).toBe('leader');
  });

  test('fresh lease → follower', () => {
    expect(decideRole(NOW - 1000, NOW, 5000)).toBe('follower');
    expect(decideRole(NOW, NOW, 5000)).toBe('follower');
  });
});

describe('mergeRateLimits', () => {
  const win = (used: number, resets: number) => ({ used_percentage: used, resets_at: resets });
  // resets_at is epoch SECONDS; NOW is epoch ms. These two sit in NOW's future, 10 min apart —
  // the same gap the real account-switch bug had (19:00Z current vs 19:10Z from the old account).
  const SOON = Math.floor(NOW / 1000) + 600;
  const LATER = SOON + 600;

  test('both empty → null', () => {
    expect(mergeRateLimits(null, null, NOW)).toBeNull();
    expect(mergeRateLimits({}, {}, NOW)).toBeNull();
  });

  test('one side missing a window → the other side wins', () => {
    expect(mergeRateLimits({ five_hour: win(10, 100) }, null, NOW)).toEqual({ five_hour: win(10, 100) });
    expect(mergeRateLimits(null, { seven_day: win(5, 200) }, NOW)).toEqual({ seven_day: win(5, 200) });
  });

  test('later resets_at wins once the earlier window has expired (a real rollover)', () => {
    const old = { five_hour: win(97, 100) }; // nearly exhausted, and long past its reset
    const fresh = { five_hour: win(3, 100 + 5 * 3600) }; // rolled over: later reset, low used%
    expect(mergeRateLimits(old, fresh, NOW)).toEqual(fresh);
    expect(mergeRateLimits(fresh, old, NOW)).toEqual(fresh); // order-independent
  });

  test('a later resets_at does NOT win while the current window is still live', () => {
    // The account-switch case: a pane left signed in elsewhere keeps shipping ITS account's
    // window, which happens to reset later. A window only rolls forward once the old one
    // expires, so before SOON that reading is another account's, not a rollover.
    const current = { five_hour: win(43, SOON) };
    const foreign = { five_hour: win(115, LATER) };
    expect(mergeRateLimits(current, foreign, NOW)).toEqual(current);
    expect(mergeRateLimits(foreign, current, NOW)).toEqual(current); // order-independent
    // …and once SOON has passed, the later window is a genuine rollover again.
    expect(mergeRateLimits(current, foreign, SOON * 1000)).toEqual(foreign);
  });

  test('same reset → higher used% wins (the more advanced reading within a window)', () => {
    const idle = { five_hour: win(40, 500) };
    const active = { five_hour: win(63, 500) };
    expect(mergeRateLimits(idle, active, NOW)).toEqual(active);
  });

  test('windows merge independently', () => {
    const a = { five_hour: win(10, 500), seven_day: win(80, 9000) };
    const b = { five_hour: win(25, 500), seven_day: win(50, 9000) };
    // five_hour: same reset → 25 wins; seven_day: same reset → 80 wins.
    expect(mergeRateLimits(a, b, NOW)).toEqual({ five_hour: win(25, 500), seven_day: win(80, 9000) });
  });
});

describe('parseStoredLimits', () => {
  const win = (used: number, resets: number) => ({ used_percentage: used, resets_at: resets });
  const ACCT = 'acct-uuid-1';
  const stored = (account: string | null): string =>
    JSON.stringify({ account, five_hour: win(63, 500) } satisfies StoredLimits);

  test('a matching stamp passes the windows through, without the account', () => {
    expect(parseStoredLimits(stored(ACCT), ACCT, NOW)).toEqual({ five_hour: win(63, 500) });
  });

  test('a different account → null (the switch case: discard, do not ratchet)', () => {
    expect(parseStoredLimits(stored('acct-uuid-OTHER'), ACCT, NOW)).toBeNull();
  });

  test('a legacy stamp-less file → null for a real account (invalidated exactly once)', () => {
    expect(parseStoredLimits(JSON.stringify({ five_hour: win(63, 500) }), ACCT, NOW)).toBeNull();
  });

  test('a null account (API-key / unreadable ~/.claude.json) reads its own bucket', () => {
    expect(parseStoredLimits(stored(null), null, NOW)).toEqual({ five_hour: win(63, 500) });
    // …and an absent stamp normalises to null, so it reads as the same bucket.
    expect(parseStoredLimits(JSON.stringify({ five_hour: win(63, 500) }), null, NOW)).toEqual({
      five_hour: win(63, 500),
    });
    // A real account's merge is still not readable as the null bucket's.
    expect(parseStoredLimits(stored(ACCT), null, NOW)).toBeNull();
  });

  test('bad JSON / non-object / no usable window → null (never throws)', () => {
    expect(parseStoredLimits('not json', ACCT, NOW)).toBeNull();
    expect(parseStoredLimits('null', ACCT, NOW)).toBeNull();
    expect(parseStoredLimits('"a string"', ACCT, NOW)).toBeNull();
    expect(parseStoredLimits(JSON.stringify({ account: ACCT }), ACCT, NOW)).toBeNull();
  });
});

describe('storedLimitsAccount', () => {
  test('reads the stamp, and reports null for an unstamped or unparseable file', () => {
    expect(storedLimitsAccount(JSON.stringify({ account: 'acct-uuid-1', five_hour: {} }))).toBe('acct-uuid-1');
    expect(storedLimitsAccount(JSON.stringify({ account: null }))).toBeNull();
    expect(storedLimitsAccount(JSON.stringify({ five_hour: {} }))).toBeNull();
    expect(storedLimitsAccount('not json')).toBeNull();
    expect(storedLimitsAccount('null')).toBeNull();
  });
});

describe('buildSnapshot', () => {
  const entries: TokenEntry[] = [
    { id: 'a', tok: 120, ts: NOW, session: 'me' },
    { id: 'b', tok: 240, ts: NOW - 1000, session: 'other' },
  ];
  const files: FileActivity[] = [{ session: 'me', subagent: null, mtimeMs: NOW - 1000, state: 'busy', stateAtMs: NOW - 1000 }];
  const limits: MergedRateLimits = { five_hour: { used_percentage: 20, resets_at: 999 } };

  test('freezes rates, counts, version, cfgKey, asOf, limits, ccusage line', () => {
    const snap = buildSnapshot(entries, files, NOW, baseConfig, limits, 'CCUSAGE-LINE');
    expect(snap.v).toBe(1);
    expect(snap.cfgKey).toBe(cfgKey(baseConfig));
    expect(snap.asOf).toBe(NOW);
    expect(snap.all).toBe(3); // round((120+240)/120)
    expect(snap.bySession).toEqual({ me: 1, other: 2 });
    expect(snap.counts).toEqual({ sessions: 1, subagents: 0 });
    expect(snap.limits).toBe(limits);
    expect(snap.ccusage).toBe('CCUSAGE-LINE');
  });
});

describe('parseSnapshot + snapshotUsable', () => {
  const snap = buildSnapshot([], [], NOW, baseConfig, null, null);

  test('round-trips a valid snapshot', () => {
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
  });

  test('rejects bad JSON, wrong version, and missing fields', () => {
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot(JSON.stringify({ ...snap, v: 999 }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ ...snap, all: undefined }))).toBeNull();
    expect(parseSnapshot(JSON.stringify({ ...snap, bySession: undefined }))).toBeNull();
  });

  test('usable only when cfgKey matches and asOf is within the freshness budget', () => {
    expect(snapshotUsable(snap, NOW, baseConfig, 10_000)).toBe(true);
    expect(snapshotUsable(snap, NOW + 9_999, baseConfig, 10_000)).toBe(true);
    expect(snapshotUsable(snap, NOW + 10_000, baseConfig, 10_000)).toBe(false); // stale
    expect(snapshotUsable(snap, NOW, { ...baseConfig, windowSec: 180 }, 10_000)).toBe(false); // wrong cfg
  });
});

// Integration: a leader tick and a follower tick, over the e2e fixtures, in a scratch
// state dir. A pre-seeded (fresh-mtimed) ccusage line + job marker keep the leader from
// spawning a real ccusage recompute, so the test is hermetic and fast.
describe('resolveSnapshot — leader then follower coherence', () => {
  const PROJECTS_DIR = new URL('./fixtures/projects', import.meta.url).pathname;
  const config: Config = { ...baseConfig, projectsDir: PROJECTS_DIR };
  const CCUSAGE_LINE =
    '🤖 Opus 4.8 | 💰 $13.50 session / $330.00 today / $31.25 block (2h 35m left) | 🔥 $13.18/hr';
  const ACCOUNT = 'acct-uuid-1';
  // epoch SECONDS, both still in NOW's future: SOON is this account's live window, LATER the
  // window a pane left signed in to the previous account keeps reporting.
  const SOON = Math.floor(NOW / 1000) + 600;
  const LATER = SOON + 600;
  const limitsOnDisk = async (): Promise<StoredLimits> =>
    JSON.parse(await Bun.file(`${dir}/ccss-limits.json`).text()) as StoredLimits;

  let dir: string;
  const prev = process.env.CCSS_STATE_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(`${tmpdir()}/ccss-shared-`);
    process.env.CCSS_STATE_DIR = dir;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.CCSS_STATE_DIR;
    else process.env.CCSS_STATE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clear coordination state; seed a ccusage line + job marker stamped at NOW so the
    // spawn gate sees "fresh line / job running" and never launches ccusage.
    await rm(`${dir}/ccss-claim`, { force: true });
    await rm(`${dir}/ccss-snap-${cfgKey(config)}.json`, { force: true });
    await rm(`${dir}/ccss-limits.json`, { force: true });
    await Bun.write(`${dir}/ccss-ccusage.line`, CCUSAGE_LINE);
    await Bun.write(`${dir}/ccss-ccusage.job`, '1');
    const sec = NOW / 1000;
    await utimes(`${dir}/ccss-ccusage.line`, sec, sec);
    await utimes(`${dir}/ccss-ccusage.job`, sec, sec);
  });

  const leaderInput: StatuslineInput = { session_id: 'sessCUR', transcript_path: `${PROJECTS_DIR}/enc-cur/sessCUR.jsonl` };

  test('first tick with no claim leads: walks fixtures, embeds the ccusage line, writes the snapshot', async () => {
    const snap = await resolveSnapshot(config, leaderInput, '{}', NOW, ACCOUNT);
    expect(snap.all).toBe(322); // same all-sessions rate the e2e asserts
    expect(snap.bySession.sessCUR).toBe(163);
    expect(snap.ccusage).toBe(CCUSAGE_LINE);
    // The snapshot was published for followers.
    const onDisk = parseSnapshot(await Bun.file(`${dir}/ccss-snap-${cfgKey(config)}.json`).text());
    expect(onDisk).toEqual(snap);
  });

  test('a second session, claim now fresh, follows: reads the identical global snapshot', async () => {
    const leader = await resolveSnapshot(config, leaderInput, '{}', NOW, ACCOUNT);
    // Different session; the leader just stamped a fresh claim → this tick is a follower.
    const followerInput: StatuslineInput = { session_id: 'sessOTHER' };
    const follower = await resolveSnapshot(config, followerInput, '{}', NOW, ACCOUNT);
    expect(follower).toEqual(leader); // byte-identical globals — the whole point
  });

  test('with no usable snapshot a follower falls back to a local walk (renders, does not publish)', async () => {
    // Seed a FRESH claim (so this tick is a follower) but NO snapshot on disk.
    await writeSnapshot(buildSnapshot([], [], NOW, { ...config, windowSec: 999 }, null, null), {
      ...config,
      windowSec: 999,
    }); // a snapshot under a DIFFERENT cfgKey — unusable for our config
    await Bun.write(`${dir}/ccss-claim`, String(NOW));
    await utimes(`${dir}/ccss-claim`, NOW / 1000, NOW / 1000);

    const follower = await resolveSnapshot(config, { session_id: 'sessCUR' }, '{}', NOW, ACCOUNT);
    // Local fallback still computes real numbers from the fixtures…
    expect(follower.all).toBe(322);
    // …but must NOT have published a snapshot for our cfgKey (only leaders publish).
    expect(await Bun.file(`${dir}/ccss-snap-${cfgKey(config)}.json`).exists()).toBe(false);
  });

  // Regression: before the merge was account-scoped, a switch left the ⚡ bars pinned to the
  // previous account until its windows expired — five_hour reading 0% remaining for hours.
  test('an account switch discards the stored merge on BOTH branches and restamps the file', async () => {
    // The previous account's merge, rigged to win under an unscoped merge two different ways:
    // five_hour resets LATER (the resets_at branch), seven_day has an IDENTICAL reset but a
    // higher used% (the tie branch, which no resets_at heuristic could catch).
    await Bun.write(
      `${dir}/ccss-limits.json`,
      JSON.stringify({
        account: 'acct-uuid-OLD',
        five_hour: { used_percentage: 115, resets_at: 2_000_600 },
        seven_day: { used_percentage: 90, resets_at: 9_000_000 },
      } satisfies StoredLimits),
    );

    const live: MergedRateLimits = {
      five_hour: { used_percentage: 43, resets_at: 2_000_000 },
      seven_day: { used_percentage: 35, resets_at: 9_000_000 },
    };
    const snap = await resolveSnapshot(config, { session_id: 'sessCUR', rate_limits: live }, '{}', NOW, ACCOUNT);

    expect(snap.limits).toEqual(live); // the live reading, not the old account's ratchet
    expect((await limitsOnDisk()).account).toBe(ACCOUNT); // restamped, so the next tick reads it back as ours
  });

  // Regression: scoping the stored file is only half the fix. A pane left signed in to the
  // previous account reads the SAME ~/.claude.json, so it stamps its contribution with the new
  // account and the stamp cannot filter it — only `mergeWindow`'s expiry condition can.
  test('a pane still on the previous account cannot re-pin the bars after the switch', async () => {
    const live: MergedRateLimits = { five_hour: { used_percentage: 43, resets_at: SOON } };
    await resolveSnapshot(config, { session_id: 'sessCUR', rate_limits: live }, '{}', NOW, ACCOUNT);
    expect((await limitsOnDisk()).five_hour).toEqual({ used_percentage: 43, resets_at: SOON });

    // The stale pane's window resets LATER, which used to read as a rollover and win outright.
    const stale: MergedRateLimits = { five_hour: { used_percentage: 115, resets_at: LATER } };
    await resolveSnapshot(config, { session_id: 'sessOTHER', rate_limits: stale }, '{}', NOW, ACCOUNT);

    expect((await limitsOnDisk()).five_hour).toEqual({ used_percentage: 43, resets_at: SOON });
  });

  // Regression: one file holds one bucket, so a tick with no readable account must not stamp
  // null over a real account's accumulated cross-pane maximum.
  test('a tick that cannot read an account leaves a stamped bucket untouched', async () => {
    await Bun.write(
      `${dir}/ccss-limits.json`,
      JSON.stringify({ account: ACCOUNT, five_hour: { used_percentage: 63, resets_at: SOON } } satisfies StoredLimits),
    );

    const idle: MergedRateLimits = { five_hour: { used_percentage: 12, resets_at: SOON } };
    await resolveSnapshot(config, { session_id: 'sessCUR', rate_limits: idle }, '{}', NOW, null);

    const onDisk = await limitsOnDisk();
    expect(onDisk.account).toBe(ACCOUNT);
    expect(onDisk.five_hour).toEqual({ used_percentage: 63, resets_at: SOON });
  });

  test('within one account the monotone ratchet still holds — an idle pane cannot regress it', async () => {
    await Bun.write(
      `${dir}/ccss-limits.json`,
      JSON.stringify({
        account: ACCOUNT,
        five_hour: { used_percentage: 63, resets_at: 2_000_000 },
      } satisfies StoredLimits),
    );

    const idle: MergedRateLimits = { five_hour: { used_percentage: 40, resets_at: 2_000_000 } };
    const snap = await resolveSnapshot(config, { session_id: 'sessCUR', rate_limits: idle }, '{}', NOW, ACCOUNT);

    expect(snap.limits?.five_hour).toEqual({ used_percentage: 63, resets_at: 2_000_000 });
  });
});
