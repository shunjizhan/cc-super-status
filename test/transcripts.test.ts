import { describe, expect, test } from 'bun:test';

import { parseTranscriptText } from '../src/transcripts';

// One assistant transcript line as a JSON string.
const line = (
  id: string,
  timestamp: string,
  usage: Record<string, number>,
): string => JSON.stringify({ type: 'assistant', timestamp, message: { id, usage } });

const TS = '2026-05-31T12:01:00.000Z';
const TS_MS = Date.parse(TS);

describe('parseTranscriptText — cache token inclusion', () => {
  const usage = {
    input_tokens: 2000,
    output_tokens: 1000,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 8000,
  };

  test('includeCache=true sums input + output + cache_creation + cache_read', () => {
    const entries = parseTranscriptText(line('m1', TS, usage), true, true);
    expect(entries).toEqual([{ id: 'm1', tok: 12000, ts: TS_MS, current: true }]);
  });

  test('includeCache=false counts only input + output', () => {
    const entries = parseTranscriptText(line('m1', TS, usage), false, false);
    expect(entries).toEqual([{ id: 'm1', tok: 3000, ts: TS_MS, current: false }]);
  });

  test('missing cache fields default to 0 when cache included', () => {
    const entries = parseTranscriptText(line('m2', TS, { input_tokens: 2000, output_tokens: 1000 }), true, true);
    expect(entries[0]?.tok).toBe(3000);
  });

  test('a cache-only message counts when cache included, is skipped (tok<=0) when excluded', () => {
    const cacheOnly = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5000 };
    expect(parseTranscriptText(line('m3', TS, cacheOnly), false, true)[0]?.tok).toBe(5000);
    expect(parseTranscriptText(line('m3', TS, cacheOnly), false, false)).toEqual([]);
  });
});

describe('parseTranscriptText — line handling', () => {
  test('the current flag is propagated onto every entry', () => {
    const text = [
      line('m1', TS, { input_tokens: 100, output_tokens: 0 }),
      line('m2', TS, { input_tokens: 200, output_tokens: 0 }),
    ].join('\n');
    expect(parseTranscriptText(text, true, true).every((e) => e.current)).toBe(true);
  });

  test('skips blank lines, non-JSON (truncated tail), and lines without usage', () => {
    const text = [
      '',
      '   ',
      '{ this is not json',
      JSON.stringify({ type: 'user', message: { id: 'u1' } }), // no usage
      line('ok', TS, { input_tokens: 500, output_tokens: 0 }),
    ].join('\n');
    expect(parseTranscriptText(text, false, true)).toEqual([
      { id: 'ok', tok: 500, ts: TS_MS, current: false },
    ]);
  });

  test('skips entries with a missing or unparseable timestamp', () => {
    const noTs = JSON.stringify({ type: 'assistant', message: { id: 'x', usage: { input_tokens: 9 } } });
    const badTs = line('y', 'not-a-date', { input_tokens: 9 });
    expect(parseTranscriptText([noTs, badTs].join('\n'), false, true)).toEqual([]);
  });

  test('falls back to the raw timestamp string as id when message.id is absent', () => {
    const noId = JSON.stringify({ type: 'assistant', timestamp: TS, message: { usage: { input_tokens: 9 } } });
    expect(parseTranscriptText(noId, false, true)[0]?.id).toBe(TS);
  });
});
