import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { barScaleForMode, detectRateLimitTier, planBarScale } from '../src/plan';

describe('planBarScale', () => {
  test('Max 20x → 4× the bar (20/5)', () => {
    expect(planBarScale('default_claude_max_20x')).toBe(4);
  });

  test('Max 5x → 1× (the baseline)', () => {
    expect(planBarScale('default_claude_max_5x')).toBe(1);
  });

  test('non-Max / unknown / absent → 1× (default bar)', () => {
    expect(planBarScale('claude_team')).toBe(1);
    expect(planBarScale('default_claude_pro')).toBe(1);
    expect(planBarScale(null)).toBe(1);
    expect(planBarScale(undefined)).toBe(1);
    expect(planBarScale('')).toBe(1);
  });

  test('generalises to other Max multiples, but never shrinks below 1×', () => {
    expect(planBarScale('default_claude_max_40x')).toBe(8); // 40/5
    // A hypothetical sub-5x tier is clamped to the baseline — detection only lengthens.
    expect(planBarScale('default_claude_max_1x')).toBe(1);
  });
});

describe('barScaleForMode', () => {
  const T20 = 'default_claude_max_20x';
  const T5 = 'default_claude_max_5x';

  test('max / 4x → force 4× regardless of tier (case-insensitive)', () => {
    expect(barScaleForMode('max', null)).toBe(4);
    expect(barScaleForMode('4x', T5)).toBe(4); // beats a 5x plan
    expect(barScaleForMode('MAX', undefined)).toBe(4);
    expect(barScaleForMode(' max ', null)).toBe(4);
  });

  test('default / normal / 1x → force 1× even on Max 20x', () => {
    expect(barScaleForMode('default', T20)).toBe(1);
    expect(barScaleForMode('normal', T20)).toBe(1);
    expect(barScaleForMode('1x', T20)).toBe(1);
  });

  test('auto / unset / unrecognised → detect from the tier', () => {
    expect(barScaleForMode('auto', T20)).toBe(4);
    expect(barScaleForMode(undefined, T20)).toBe(4);
    expect(barScaleForMode(undefined, T5)).toBe(1);
    expect(barScaleForMode('', T20)).toBe(4); // blank → auto
    expect(barScaleForMode('gibberish', T20)).toBe(4); // unknown value → auto, not an error
    expect(barScaleForMode('auto', null)).toBe(1); // auto with no detectable tier → default
  });
});

// FS-touching tests point at a scratch fixture so they never read the user's real
// ~/.claude.json.
describe('detectRateLimitTier (scratch fixture)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(`${tmpdir()}/ccss-plan-`);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, body: string): Promise<string> => {
    const p = `${dir}/${name}`;
    await writeFile(p, body);
    return p;
  };

  test('reads organizationRateLimitTier from a real-shaped file', async () => {
    const p = await write(
      'org.json',
      JSON.stringify({
        oauthAccount: { userRateLimitTier: null, organizationRateLimitTier: 'default_claude_max_20x' },
      }),
    );
    expect(detectRateLimitTier(p)).toBe('default_claude_max_20x');
  });

  test('falls back to userRateLimitTier when the org tier is null', async () => {
    const p = await write(
      'user.json',
      JSON.stringify({
        oauthAccount: { organizationRateLimitTier: null, userRateLimitTier: 'default_claude_max_5x' },
      }),
    );
    expect(detectRateLimitTier(p)).toBe('default_claude_max_5x');
  });

  test('a missing file → null (no throw)', () => {
    expect(detectRateLimitTier(`${dir}/does-not-exist.json`)).toBeNull();
  });

  test('a file with no tier field → null', async () => {
    const p = await write('none.json', JSON.stringify({ oauthAccount: { displayName: 'x' } }));
    expect(detectRateLimitTier(p)).toBeNull();
  });

  test('a torn / partial write → null (the regex just misses, never throws)', async () => {
    const p = await write('partial.json', '{"oauthAccount":{"organizationRateLimitTier":"default_cla');
    expect(detectRateLimitTier(p)).toBeNull();
  });
});
