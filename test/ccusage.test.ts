import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { CcusageData, Config } from '../src/types';
import {
  buildJobScript,
  claimSpawnSlot,
  maybeSpawnCcusageJob,
  parseCcusage,
  readCcusageLine,
  shouldSpawnJob,
  staleLineStillCurrent,
} from '../src/ccusage';

describe('parseCcusage', () => {
  it('parses the example line into all five fields', () => {
    const line =
      '🤖 Opus 4.8 (1M context) | 💰 $-0.00 session / $313.92 today / $15.21 block (4h 15m left) | 🔥 $21.01/hr | 🧠 66,429 (7%)';

    const result = parseCcusage(line);

    expect(result).toEqual({
      session: -0,
      today: 313.92,
      block: 15.21,
      burn: '$21.01/hr',
      timeLeft: '4h 15m',
    } satisfies CcusageData);
  });

  it('parses a negative session value', () => {
    const line =
      '🤖 Opus 4.8 | 💰 $-12.34 session / $50.00 today / $7.50 block (2h 35m left) | 🔥 $13.18/hr | 🧠 1,000 (2%)';

    const result = parseCcusage(line);

    expect(result).not.toBeNull();
    expect(result?.session).toBe(-12.34);
    expect(result?.today).toBe(50);
    expect(result?.block).toBe(7.5);
    expect(result?.burn).toBe('$13.18/hr');
    expect(result?.timeLeft).toBe('2h 35m');
  });

  it('returns null on a malformed line', () => {
    expect(parseCcusage('this is not a ccusage statusline')).toBeNull();
    expect(parseCcusage('💰 $5.00 session only, no today/block')).toBeNull();
    expect(parseCcusage('')).toBeNull();
  });
});

describe('staleLineStillCurrent', () => {
  const line = (timeLeft: string): string =>
    `🤖 Opus 4.8 | 💰 $1.00 session / $50.00 today / $7.50 block (${timeLeft} left) | 🔥 $13.18/hr`;

  it('usable while younger than the block time left', () => {
    expect(staleLineStillCurrent(line('4h 15m'), 60_000)).toBe(true);
    expect(staleLineStillCurrent(line('5m'), 4 * 60_000)).toBe(true);
    expect(staleLineStillCurrent(line('1h'), 59 * 60_000)).toBe(true);
  });

  it('unusable once the block it describes has reset', () => {
    expect(staleLineStillCurrent(line('4m'), 5 * 60_000)).toBe(false);
    expect(staleLineStillCurrent(line('1h'), 61 * 60_000)).toBe(false);
    // boundary: age exactly equal to time left → the block just ended
    expect(staleLineStillCurrent(line('5m'), 5 * 60_000)).toBe(false);
  });

  it('unparseable cost segment or time-left is served as-is', () => {
    expect(staleLineStillCurrent('🤖 Opus 4.8 | 🧠 66,429 (7%)', 600_000)).toBe(true);
    expect(staleLineStillCurrent(line('soon'), 600_000)).toBe(true);
  });
});

describe('shouldSpawnJob', () => {
  const REFRESH = 30_000; // config.ccusageRefreshSec * 1000

  test('a fresh line blocks a spawn regardless of job state', () => {
    expect(shouldSpawnJob(10_000, Infinity, REFRESH)).toBe(false); // line 10s old < 30s
    expect(shouldSpawnJob(REFRESH, Infinity, REFRESH)).toBe(false); // exactly at the interval
  });

  test('a stale line with a job already running still blocks (one job machine-wide)', () => {
    expect(shouldSpawnJob(45_000, 5_000, REFRESH)).toBe(false); // marker 5s old → job alive
    expect(shouldSpawnJob(45_000, 29_000, REFRESH)).toBe(false); // still under the 30s dead-job cutoff
  });

  test('a stale line with no job (or a dead one) spawns', () => {
    expect(shouldSpawnJob(45_000, Infinity, REFRESH)).toBe(true); // no marker
    expect(shouldSpawnJob(Infinity, Infinity, REFRESH)).toBe(true); // no line yet either (cold start)
    expect(shouldSpawnJob(45_000, 31_000, REFRESH)).toBe(true); // marker 31s old → presumed dead
  });
});

describe('buildJobScript', () => {
  const paths = {
    cmd: ['/usr/bin/ccusage', 'statusline', '--refresh-interval', '10'],
    payload: '/state/ccss-ccusage.payload',
    tmp: '/state/ccss-ccusage.123.tmp',
    line: '/state/ccss-ccusage.line',
    marker: '/state/ccss-ccusage.job',
  };

  test('redirects stdin from the payload, guards empty output, atomically renames, cleans up', () => {
    const script = buildJobScript(paths);
    expect(script).toContain(`< '/state/ccss-ccusage.payload'`);
    expect(script).toContain(`> '/state/ccss-ccusage.123.tmp'`);
    expect(script).toContain(`[ -s '/state/ccss-ccusage.123.tmp' ]`);
    expect(script).toContain(`mv -f '/state/ccss-ccusage.123.tmp' '/state/ccss-ccusage.line'`);
    expect(script).toContain(`rm -f '/state/ccss-ccusage.123.tmp' '/state/ccss-ccusage.job'`);
    expect(script).toContain(`'/usr/bin/ccusage' 'statusline' '--refresh-interval' '10'`);
  });

  test('single-quotes in a path are escaped, not left to break out of the quoting', () => {
    const script = buildJobScript({ ...paths, line: "/state/o'brien.line" });
    expect(script).toContain(`'/state/o'\\''brien.line'`);
  });
});

// FS-touching tests point CCSS_STATE_DIR at a scratch dir so they never read or clobber
// the user's LIVE statusline files under $TMPDIR.
describe('readCcusageLine + spawn mechanism (scratch state dir)', () => {
  let dir: string;
  const prev = process.env.CCSS_STATE_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(`${tmpdir()}/ccss-test-`);
    process.env.CCSS_STATE_DIR = dir;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.CCSS_STATE_DIR;
    else process.env.CCSS_STATE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });

  const linePath = () => `${dir}/ccss-ccusage.line`;
  const validLine = (timeLeft: string): string =>
    `🤖 Opus 4.8 | 💰 $1.00 session / $50.00 today / $7.50 block (${timeLeft} left) | 🔥 $13.18/hr`;
  // Read back the just-written file's mtime so `now` offsets are deterministic.
  const mtimeOf = async (p: string): Promise<number> => (await stat(p)).mtimeMs;

  test('absent line file → null', async () => {
    await rm(linePath(), { force: true });
    expect(await readCcusageLine(Date.now())).toBeNull();
  });

  test('a fresh, current line is returned trimmed', async () => {
    await Bun.write(linePath(), `  ${validLine('2h')}\n`);
    const mt = await mtimeOf(linePath());
    expect(await readCcusageLine(mt + 1000)).toBe(validLine('2h'));
  });

  test('a line older than 10 minutes → null', async () => {
    await Bun.write(linePath(), validLine('2h'));
    const mt = await mtimeOf(linePath());
    expect(await readCcusageLine(mt + 11 * 60_000)).toBeNull();
  });

  test('a line whose 5-hour block has since reset → null (block-reset guard)', async () => {
    await Bun.write(linePath(), validLine('4m'));
    const mt = await mtimeOf(linePath());
    // 5 min old, block said 4m left → the block ended → not served.
    expect(await readCcusageLine(mt + 5 * 60_000)).toBeNull();
  });

  test('an empty line file → null', async () => {
    await Bun.write(linePath(), '');
    const mt = await mtimeOf(linePath());
    expect(await readCcusageLine(mt + 1000)).toBeNull();
  });

  test('the job shell mechanism: payload → tmp → atomic rename onto the line, marker cleared', async () => {
    const payload = `${dir}/ccss-ccusage.payload`;
    const tmp = `${dir}/ccss-ccusage.smoke.tmp`;
    const marker = `${dir}/ccss-ccusage.job`;
    const line = linePath();
    await Bun.write(payload, 'RECOMPUTED-LINE\n');
    await Bun.write(marker, '999');
    // `cat` stands in for ccusage: it echoes the payload to stdout.
    const script = buildJobScript({ cmd: ['cat'], payload, tmp, line, marker });
    await Bun.spawn(['sh', '-c', script]).exited;
    expect((await Bun.file(line).text()).trim()).toBe('RECOMPUTED-LINE');
    expect(await Bun.file(tmp).exists()).toBe(false); // renamed away
    expect(await Bun.file(marker).exists()).toBe(false); // cleaned up for the next spawn
  });

  test('an empty recompute leaves the previous good line untouched (the -s guard)', async () => {
    const payload = `${dir}/ccss-ccusage.payload`;
    const tmp = `${dir}/ccss-ccusage.smoke2.tmp`;
    const marker = `${dir}/ccss-ccusage.job`;
    const line = linePath();
    await Bun.write(line, 'PREVIOUS-GOOD');
    await Bun.write(payload, 'ignored');
    await Bun.write(marker, '999');
    // `true` produces no output → tmp is empty → the `-s` guard skips the rename.
    const script = buildJobScript({ cmd: ['true'], payload, tmp, line, marker });
    await Bun.spawn(['sh', '-c', script]).exited;
    expect((await Bun.file(line).text()).trim()).toBe('PREVIOUS-GOOD');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test('maybeSpawnCcusageJob does not spawn when the line is fresh', async () => {
    await Bun.write(linePath(), validLine('2h'));
    const mt = await mtimeOf(linePath());
    const config = { ccusageRefreshSec: 30 } as Config;
    // now only 1s after the line was written → within the refresh interval.
    expect(await maybeSpawnCcusageJob('{}', mt + 1000, config)).toBe(false);
  });

  test('claimSpawnSlot serialises a burst to one winner, but reclaims a stale marker', async () => {
    const marker = `${dir}/ccss-ccusage.claim-test`;
    await rm(marker, { force: true });
    const now = Date.now();
    // First caller wins (exclusive create); every simultaneous peer loses.
    expect(claimSpawnSlot(marker, now)).toBe(true);
    expect(claimSpawnSlot(marker, now)).toBe(false);
    expect(claimSpawnSlot(marker, now)).toBe(false);
    // A stale marker (dead job that never cleaned up) is reclaimable.
    const staleSec = (now - 40_000) / 1000;
    await utimes(marker, staleSec, staleSec);
    expect(claimSpawnSlot(marker, now)).toBe(true);
    await rm(marker, { force: true });
  });
});
