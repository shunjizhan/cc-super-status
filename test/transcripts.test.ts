import { describe, expect, test } from 'bun:test';

import type { FileActivity } from '../src/types';
import { countActive, parseTranscriptText, sessionOrigin, tokenCount } from '../src/transcripts';

// One assistant transcript line as a JSON string.
const line = (
  id: string,
  timestamp: string,
  usage: Record<string, number>,
): string => JSON.stringify({ type: 'assistant', timestamp, message: { id, usage } });

const TS = '2026-05-31T12:01:00.000Z';
const TS_MS = Date.parse(TS);
const SESS = 'sess1'; // the owning session tag threaded through parseTranscriptText

// Raw mode (every component ×1) — the historical behavior these tests assert.
const RAW_CACHE = { includeCache: true, effectiveRate: false };
const RAW_NOCACHE = { includeCache: false, effectiveRate: false };

describe('tokenCount', () => {
  const usage = {
    input_tokens: 2000,
    output_tokens: 1000,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 8000,
  };

  test('raw + cache: all four components summed at weight 1', () => {
    expect(tokenCount(usage, { includeCache: true, effectiveRate: false })).toBe(12000);
  });

  test('raw, cache excluded: input + output only', () => {
    expect(tokenCount(usage, { includeCache: false, effectiveRate: false })).toBe(3000);
  });

  test('effective + cache: input + output×5 + cacheWrite×2 + cacheRead×0.1', () => {
    // 2000 + 5000 + 2000 + 800 = 9800
    expect(tokenCount(usage, { includeCache: true, effectiveRate: true })).toBe(9800);
  });

  test('effective, cache excluded: input + output×5 only', () => {
    // 2000 + 5000 = 7000
    expect(tokenCount(usage, { includeCache: false, effectiveRate: true })).toBe(7000);
  });

  test('effective cache-read weight is 0.1 and may be fractional', () => {
    const cacheOnly = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5005 };
    // 5005 × 0.1 = 500.5
    expect(tokenCount(cacheOnly, { includeCache: true, effectiveRate: true })).toBeCloseTo(500.5);
  });

  test('missing components default to 0', () => {
    expect(tokenCount({}, { includeCache: true, effectiveRate: true })).toBe(0);
  });
});

describe('parseTranscriptText — cache token inclusion (raw mode)', () => {
  const usage = {
    input_tokens: 2000,
    output_tokens: 1000,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 8000,
  };

  test('includeCache=true sums input + output + cache_creation + cache_read', () => {
    const entries = parseTranscriptText(line('m1', TS, usage), SESS, RAW_CACHE);
    expect(entries).toEqual([{ id: 'm1', tok: 12000, ts: TS_MS, session: SESS }]);
  });

  test('includeCache=false counts only input + output', () => {
    const entries = parseTranscriptText(line('m1', TS, usage), SESS, RAW_NOCACHE);
    expect(entries).toEqual([{ id: 'm1', tok: 3000, ts: TS_MS, session: SESS }]);
  });

  test('missing cache fields default to 0 when cache included', () => {
    const entries = parseTranscriptText(line('m2', TS, { input_tokens: 2000, output_tokens: 1000 }), SESS, RAW_CACHE);
    expect(entries[0]?.tok).toBe(3000);
  });

  test('a cache-only message counts when cache included, is skipped (tok<=0) when excluded', () => {
    const cacheOnly = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5000 };
    expect(parseTranscriptText(line('m3', TS, cacheOnly), SESS, RAW_CACHE)[0]?.tok).toBe(5000);
    expect(parseTranscriptText(line('m3', TS, cacheOnly), SESS, RAW_NOCACHE)).toEqual([]);
  });
});

describe('parseTranscriptText — effective (charge-weighted) mode', () => {
  const usage = {
    input_tokens: 2000,
    output_tokens: 1000,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 8000,
  };

  test('weights the components: input + output×5 + cacheWrite×2 + cacheRead×0.1', () => {
    const entries = parseTranscriptText(line('m1', TS, usage), SESS, { includeCache: true, effectiveRate: true });
    expect(entries).toEqual([{ id: 'm1', tok: 9800, ts: TS_MS, session: SESS }]);
  });

  test('cache excluded drops the cache terms, output still ×5', () => {
    const entries = parseTranscriptText(line('m1', TS, usage), SESS, { includeCache: false, effectiveRate: true });
    expect(entries).toEqual([{ id: 'm1', tok: 7000, ts: TS_MS, session: SESS }]);
  });

  test('a cache-only message: kept as a fractional tok when cache included, skipped (tok<=0) when excluded', () => {
    const cacheOnly = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5 };
    // cache included: 5 × 0.1 = 0.5 > 0 → the fractional tok survives the `tok <= 0` filter.
    expect(
      parseTranscriptText(line('m4', TS, cacheOnly), SESS, { includeCache: true, effectiveRate: true })[0]?.tok,
    ).toBeCloseTo(0.5);
    // cache excluded: the cache term is zeroed → tok = 0 → skipped.
    expect(
      parseTranscriptText(line('m4', TS, cacheOnly), SESS, { includeCache: false, effectiveRate: true }),
    ).toEqual([]);
  });
});

describe('parseTranscriptText — line handling', () => {
  test('the session tag is set on every entry', () => {
    const text = [
      line('m1', TS, { input_tokens: 100, output_tokens: 0 }),
      line('m2', TS, { input_tokens: 200, output_tokens: 0 }),
    ].join('\n');
    expect(parseTranscriptText(text, SESS, RAW_CACHE).every((e) => e.session === SESS)).toBe(true);
  });

  test('skips blank lines, non-JSON (truncated tail), and lines without usage', () => {
    const text = [
      '',
      '   ',
      '{ this is not json',
      JSON.stringify({ type: 'user', message: { id: 'u1' } }), // no usage
      line('ok', TS, { input_tokens: 500, output_tokens: 0 }),
    ].join('\n');
    expect(parseTranscriptText(text, SESS, RAW_CACHE)).toEqual([
      { id: 'ok', tok: 500, ts: TS_MS, session: SESS },
    ]);
  });

  test('skips entries with a missing or unparseable timestamp', () => {
    const noTs = JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 9 } } });
    const badTs = line('y', 'not-a-date', { input_tokens: 9 });
    expect(parseTranscriptText([noTs, badTs].join('\n'), SESS, RAW_CACHE)).toEqual([]);
  });

  test('falls back to the raw timestamp string as id when message.id is absent', () => {
    const noId = JSON.stringify({ type: 'assistant', timestamp: TS, message: { usage: { input_tokens: 9 } } });
    expect(parseTranscriptText(noId, SESS, RAW_CACHE)[0]?.id).toBe(TS);
  });
});

describe('sessionOrigin', () => {
  test('main transcript → session = basename sans .jsonl, no subagent', () => {
    expect(sessionOrigin('/p/enc-cur/sessCUR.jsonl')).toEqual({ session: 'sessCUR', subagent: null });
  });

  test('subagent → session = the <session_id> dir before /subagents/, subagent = full path', () => {
    const p = '/p/enc-cur/sessCUR/subagents/agent-x.jsonl';
    expect(sessionOrigin(p)).toEqual({ session: 'sessCUR', subagent: p });
  });

  test('nested workflow subagent → session = <session_id>, subagent = full path', () => {
    const p = '/p/proj/85cb3055/subagents/workflows/wf_1/agent-y.jsonl';
    expect(sessionOrigin(p)).toEqual({ session: '85cb3055', subagent: p });
  });
});

describe('countActive', () => {
  const NOW = 1_780_228_920_000;
  const ACTIVE = 15_000; // 15s freshness window
  // Helper: a FileActivity touched `agoMs` before NOW.
  const file = (session: string, subagent: string | null, agoMs: number): FileActivity => ({
    session,
    subagent,
    mtimeMs: NOW - agoMs,
  });

  test('empty → zero counts', () => {
    expect(countActive([], NOW, ACTIVE)).toEqual({ sessions: 0, subagents: 0 });
  });

  test('counts distinct sessions among fresh files', () => {
    const files = [file('s1', null, 1000), file('s2', null, 2000), file('s2', null, 3000)];
    expect(countActive(files, NOW, ACTIVE)).toEqual({ sessions: 2, subagents: 0 });
  });

  test('a session and its sub-agent → one session + one sub-agent', () => {
    const files = [file('s1', null, 1000), file('s1', '/p/s1/subagents/x.jsonl', 1000)];
    expect(countActive(files, NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 1 });
  });

  test('a sub-agent busy while its main transcript is stale still marks the session active', () => {
    // Main transcript went quiet (coordinator idle-waiting), sub-agent still working.
    const files = [file('s1', null, 60_000), file('s1', '/p/s1/subagents/x.jsonl', 2000)];
    expect(countActive(files, NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 1 });
  });

  test('distinct sub-agents across sessions are each counted', () => {
    const files = [
      file('s1', '/p/s1/subagents/a.jsonl', 1000),
      file('s1', '/p/s1/subagents/b.jsonl', 1000),
      file('s2', '/p/s2/subagents/a.jsonl', 1000),
    ];
    expect(countActive(files, NOW, ACTIVE)).toEqual({ sessions: 2, subagents: 3 });
  });

  test('stale files (touched > activeMs ago) are excluded — this is what makes it agile', () => {
    const files = [
      file('live', null, 5_000), // 5s ago → fresh
      file('stale', '/p/stale/subagents/x.jsonl', 20_000), // 20s ago → dropped
    ];
    expect(countActive(files, NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 0 });
  });

  test('the freshness boundary is inclusive (touched exactly activeMs ago still counts)', () => {
    expect(countActive([file('s1', null, ACTIVE)], NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 0 });
    expect(countActive([file('s1', null, ACTIVE + 1)], NOW, ACTIVE)).toEqual({ sessions: 0, subagents: 0 });
  });
});
