import { describe, expect, test } from 'bun:test';

import type { FileActivity, TurnState } from '../src/types';
import { classifyTail, countActive, parseTranscriptText, sessionOrigin, tokenCount } from '../src/transcripts';

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

describe('classifyTail', () => {
  // Row builders mirroring real Claude Code 2.1.x transcript shapes (verified on-disk).
  const j = (o: unknown): string => JSON.stringify(o);
  const prompt = j({ type: 'user', timestamp: TS, message: { role: 'user', content: 'do the thing' } });
  const promptArr = j({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  const toolResult = j({
    type: 'user',
    timestamp: TS,
    message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] },
    toolUseResult: { stdout: 'ok' },
  });
  const asstToolUse = j({ type: 'assistant', timestamp: TS, message: { id: 'm1', stop_reason: 'tool_use', usage: { input_tokens: 1 } } });
  const asstEndTurn = j({ type: 'assistant', timestamp: TS, message: { id: 'm2', stop_reason: 'end_turn', usage: { input_tokens: 1 } } });
  const asstStreaming = j({ type: 'assistant', timestamp: TS, message: { id: 'm3', usage: { input_tokens: 1 } } }); // no stop_reason yet
  const turnDuration = j({ type: 'system', subtype: 'turn_duration', timestamp: TS });
  const stopHookSummary = j({ type: 'system', subtype: 'stop_hook_summary', timestamp: TS });
  const awaySummary = j({ type: 'system', subtype: 'away_summary', timestamp: TS });
  const apiError = j({ type: 'system', subtype: 'api_error', timestamp: TS });
  const interrupt = j({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  const commandRow = j({ type: 'user', timestamp: TS, message: { role: 'user', content: '<command-name>/effort</command-name><command-message>effort</command-message>' } });
  const metaUser = j({ type: 'user', timestamp: TS, isMeta: true, message: { role: 'user', content: 'Caveat: injected reminder' } });
  const queueOp = j({ type: 'queue-operation', operation: 'enqueue', timestamp: TS });
  const fileHistory = j({ type: 'file-history-snapshot', timestamp: TS });

  const tail = (...rows: string[]): string => rows.join('\n');

  test('trailing user prompt (string or block content) → busy', () => {
    expect(classifyTail(tail(asstEndTurn, turnDuration, prompt))).toBe('busy');
    expect(classifyTail(tail(promptArr))).toBe('busy');
  });

  test('trailing dispatched tool call → busy (a 10-minute Bash writes nothing meanwhile)', () => {
    expect(classifyTail(tail(prompt, asstToolUse))).toBe('busy');
  });

  test('trailing tool result → busy (the model continues from it)', () => {
    expect(classifyTail(tail(asstToolUse, toolResult))).toBe('busy');
  });

  test('a StructuredOutput dispatch is terminal — finished workflow agents read ended', () => {
    // Schema-returning workflow agents never write end_turn; their last act is the
    // forced StructuredOutput call (verified tail shape), then the runner stops them.
    const structured = j({
      type: 'assistant',
      timestamp: TS,
      message: { id: 'm6', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't9', name: 'StructuredOutput', input: {} }] },
    });
    expect(classifyTail(tail(structured))).toBe('ended'); // result row not yet written
    expect(classifyTail(tail(structured, toolResult))).toBe('ended'); // result defers to it
  });

  test('a tail of only tool results (assistant row cut off) → busy', () => {
    expect(classifyTail(tail(toolResult, toolResult))).toBe('busy');
  });

  test('subagent tool results (tool_result block, no toolUseResult field) are not prompts', () => {
    const subResult = j({
      type: 'user',
      timestamp: TS,
      message: { role: 'user', content: [{ tool_use_id: 't9', type: 'tool_result', content: 'ok' }] },
    });
    expect(classifyTail(tail(asstToolUse, subResult))).toBe('busy'); // defers to the Bash-ish dispatch
    const structured = j({
      type: 'assistant',
      timestamp: TS,
      message: { id: 'm7', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't9', name: 'StructuredOutput', input: {} }] },
    });
    expect(classifyTail(tail(structured, subResult))).toBe('ended'); // the finished-workflow-agent tail
  });

  test('trailing assistant row without stop_reason → stalled (mid-flush, or a runner-stopped agent)', () => {
    expect(classifyTail(tail(prompt, asstStreaming))).toBe('stalled');
  });

  test('pause_turn keeps the turn busy — the client continues it', () => {
    const paused = j({ type: 'assistant', timestamp: TS, message: { id: 'm8', stop_reason: 'pause_turn' } });
    expect(classifyTail(tail(prompt, paused))).toBe('busy');
  });

  test('assistant end_turn → ended; stop_sequence and unrecognized values also end', () => {
    expect(classifyTail(tail(toolResult, asstEndTurn))).toBe('ended');
    const stopSeq = j({ type: 'assistant', timestamp: TS, message: { id: 'm4', stop_reason: 'stop_sequence' } });
    const future = j({ type: 'assistant', timestamp: TS, message: { id: 'm5', stop_reason: 'some_future_value' } });
    expect(classifyTail(tail(stopSeq))).toBe('ended');
    expect(classifyTail(tail(future))).toBe('ended');
  });

  test('turn-end system markers → ended, and trailing meta noise is skipped over', () => {
    expect(classifyTail(tail(asstEndTurn, stopHookSummary, turnDuration))).toBe('ended');
    // away_summary / queue-operation / file-history-snapshot after the markers don't reopen the turn.
    expect(classifyTail(tail(asstEndTurn, turnDuration, awaySummary, queueOp, fileHistory))).toBe('ended');
  });

  test('trailing api_error → stalled (retrying or dead — the short-TTL lane)', () => {
    expect(classifyTail(tail(toolResult, apiError))).toBe('stalled');
  });

  test('user interrupt (Esc) → ended, even though no end_turn row ever lands', () => {
    expect(classifyTail(tail(asstToolUse, interrupt))).toBe('ended');
  });

  test('a tool result whose content quotes the interrupt phrase is still busy (results never read as interrupts)', () => {
    const quoting = j({
      type: 'user',
      timestamp: TS,
      message: { role: 'user', content: [{ tool_use_id: 't2', type: 'tool_result', content: '[Request interrupted…' }] },
      toolUseResult: {},
    });
    expect(classifyTail(tail(asstToolUse, quoting))).toBe('busy');
  });

  test('slash-command wrappers and isMeta rows are skipped — a local command never reads busy', () => {
    // /effort after an ended turn: the command row must not resurrect the session.
    expect(classifyTail(tail(asstEndTurn, turnDuration, commandRow))).toBe('ended');
    expect(classifyTail(tail(asstEndTurn, turnDuration, metaUser))).toBe('ended');
  });

  test('bare slash-command rows (no wrapper) are skipped too, but slash-leading paths are prompts', () => {
    // /compact retires the session file — its bare command row must not read busy for 30min.
    const bareCompact = j({ type: 'user', timestamp: TS, message: { role: 'user', content: '/compact' } });
    const bareWithArgs = j({ type: 'user', timestamp: TS, message: { role: 'user', content: '/k-plan the spec' } });
    expect(classifyTail(tail(asstEndTurn, turnDuration, bareCompact))).toBe('ended');
    expect(classifyTail(tail(asstEndTurn, turnDuration, bareWithArgs))).toBe('ended');
    // An absolute path has an inner slash in the first word — a real prompt, busy.
    const pathPrompt = j({ type: 'user', timestamp: TS, message: { role: 'user', content: '/Users/x/app.ts is broken' } });
    expect(classifyTail(tail(asstEndTurn, turnDuration, pathPrompt))).toBe('busy');
  });

  test('a truncated last line (mid-write read) falls through to the previous row', () => {
    expect(classifyTail(tail(prompt, asstEndTurn.slice(0, 25)))).toBe('busy');
  });

  test('no meaningful rows → null (journal.jsonl, empty or swallowed tails)', () => {
    expect(classifyTail('')).toBe(null);
    expect(classifyTail(tail(j({ type: 'result' }), j({ type: 'started' })))).toBe(null);
    expect(classifyTail(tail(queueOp, fileHistory, awaySummary))).toBe(null);
  });
});

describe('countActive', () => {
  const NOW = 1_780_228_920_000;
  const ACTIVE = 15_000; // 15s freshness window (the 'unknown' fallback lane)
  // Helper: a FileActivity whose meaningful state evidence is `agoMs` old. The
  // file mtime defaults to the same age; tests can make it newer independently.
  const file = (
    session: string,
    subagent: string | null,
    agoMs: number,
    state: TurnState = 'unknown',
    mtimeAgoMs = agoMs,
  ): FileActivity => ({
    session,
    subagent,
    mtimeMs: NOW - mtimeAgoMs,
    state,
    stateAtMs: NOW - agoMs,
  });

  describe('turn-state lanes', () => {
    test('a busy file stays counted through a long silent stretch (mtime far past activeMs)', () => {
      // 10 min without a write — a long think or tool run. The whole point of the state lane.
      expect(countActive([file('s1', null, 10 * 60_000, 'busy')], NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 0 });
    });

    test('busy corpse TTL: counted at 30min, dropped past it (a killed pane ages out)', () => {
      expect(countActive([file('s1', null, 30 * 60_000, 'busy')], NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 0 });
      expect(countActive([file('s1', null, 30 * 60_000 + 1, 'busy')], NOW, ACTIVE)).toEqual({ sessions: 0, subagents: 0 });
    });

    test('a newer metadata mtime does not refresh an old busy state', () => {
      const abandoned = file('s1', null, 31 * 60_000, 'busy', 1000);
      expect(countActive([abandoned], NOW, ACTIVE)).toEqual({ sessions: 0, subagents: 0 });
    });

    test('stall TTL: counted through a mid-flush gap or retry storm, dropped after 5min of silence', () => {
      expect(countActive([file('s1', null, 4 * 60_000, 'stalled')], NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 0 });
      expect(countActive([file('s1', null, 5 * 60_000 + 1, 'stalled')], NOW, ACTIVE)).toEqual({ sessions: 0, subagents: 0 });
    });

    test('an ended file never counts, even written this instant (fast drop at turn end)', () => {
      expect(countActive([file('s1', null, 0, 'ended')], NOW, ACTIVE)).toEqual({ sessions: 0, subagents: 0 });
    });

    test('ended main + busy sub-agent → the session stays counted via its sub-agent', () => {
      const files = [file('s1', null, 1000, 'ended'), file('s1', '/p/s1/subagents/x.jsonl', 8 * 60_000, 'busy')];
      expect(countActive(files, NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 1 });
    });

    test('busy main + ended sub-agent → the finished sub-agent drops out of M immediately', () => {
      const files = [file('s1', null, 1000, 'busy'), file('s1', '/p/s1/subagents/x.jsonl', 1000, 'ended')];
      expect(countActive(files, NOW, ACTIVE)).toEqual({ sessions: 1, subagents: 0 });
    });
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
