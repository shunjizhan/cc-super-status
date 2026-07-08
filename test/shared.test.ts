import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { Config, FileActivity, MergedRateLimits, SharedSnapshot, StatuslineInput, TokenEntry } from '../src/types';
import {
  buildSnapshot,
  cfgKey,
  decideRole,
  mergeRateLimits,
  parseSnapshot,
  resolveSnapshot,
  snapshotUsable,
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

  test('both empty → null', () => {
    expect(mergeRateLimits(null, null)).toBeNull();
    expect(mergeRateLimits({}, {})).toBeNull();
  });

  test('one side missing a window → the other side wins', () => {
    expect(mergeRateLimits({ five_hour: win(10, 100) }, null)).toEqual({ five_hour: win(10, 100) });
    expect(mergeRateLimits(null, { seven_day: win(5, 200) })).toEqual({ seven_day: win(5, 200) });
  });

  test('later resets_at wins (a window rollover beats a stale high-used% reading)', () => {
    const old = { five_hour: win(97, 100) }; // nearly exhausted, but the old window
    const fresh = { five_hour: win(3, 100 + 5 * 3600) }; // rolled over: later reset, low used%
    expect(mergeRateLimits(old, fresh)).toEqual(fresh);
    expect(mergeRateLimits(fresh, old)).toEqual(fresh); // order-independent
  });

  test('same reset → higher used% wins (the more advanced reading within a window)', () => {
    const idle = { five_hour: win(40, 500) };
    const active = { five_hour: win(63, 500) };
    expect(mergeRateLimits(idle, active)).toEqual(active);
  });

  test('windows merge independently', () => {
    const a = { five_hour: win(10, 500), seven_day: win(80, 9000) };
    const b = { five_hour: win(25, 500), seven_day: win(50, 9000) };
    // five_hour: same reset → 25 wins; seven_day: same reset → 80 wins.
    expect(mergeRateLimits(a, b)).toEqual({ five_hour: win(25, 500), seven_day: win(80, 9000) });
  });
});

describe('buildSnapshot', () => {
  const entries: TokenEntry[] = [
    { id: 'a', tok: 120, ts: NOW, session: 'me' },
    { id: 'b', tok: 240, ts: NOW - 1000, session: 'other' },
  ];
  const files: FileActivity[] = [{ session: 'me', subagent: null, mtimeMs: NOW - 1000 }];
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
    await Bun.write(`${dir}/ccss-ccusage.line`, CCUSAGE_LINE);
    await Bun.write(`${dir}/ccss-ccusage.job`, '1');
    const sec = NOW / 1000;
    await utimes(`${dir}/ccss-ccusage.line`, sec, sec);
    await utimes(`${dir}/ccss-ccusage.job`, sec, sec);
  });

  const leaderInput: StatuslineInput = { session_id: 'sessCUR', transcript_path: `${PROJECTS_DIR}/enc-cur/sessCUR.jsonl` };

  test('first tick with no claim leads: walks fixtures, embeds the ccusage line, writes the snapshot', async () => {
    const snap = await resolveSnapshot(config, leaderInput, '{}', NOW);
    expect(snap.all).toBe(322); // same all-sessions rate the e2e asserts
    expect(snap.bySession.sessCUR).toBe(163);
    expect(snap.ccusage).toBe(CCUSAGE_LINE);
    // The snapshot was published for followers.
    const onDisk = parseSnapshot(await Bun.file(`${dir}/ccss-snap-${cfgKey(config)}.json`).text());
    expect(onDisk).toEqual(snap);
  });

  test('a second session, claim now fresh, follows: reads the identical global snapshot', async () => {
    const leader = await resolveSnapshot(config, leaderInput, '{}', NOW);
    // Different session; the leader just stamped a fresh claim → this tick is a follower.
    const followerInput: StatuslineInput = { session_id: 'sessOTHER' };
    const follower = await resolveSnapshot(config, followerInput, '{}', NOW);
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

    const follower = await resolveSnapshot(config, { session_id: 'sessCUR' }, '{}', NOW);
    // Local fallback still computes real numbers from the fixtures…
    expect(follower.all).toBe(322);
    // …but must NOT have published a snapshot for our cfgKey (only leaders publish).
    expect(await Bun.file(`${dir}/ccss-snap-${cfgKey(config)}.json`).exists()).toBe(false);
  });
});
