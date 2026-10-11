import { describe, expect, it } from 'vitest';
import { foldChat, messageText, thoughtLabel, thoughtsSupported } from './chat.ts';
import type { LogLine } from './types.ts';

const line = (id: number, kind: LogLine['kind'], text: string, tool?: string): LogLine => ({ id, t: id, kind, text, tool });

describe('foldChat', () => {
  it('groups a run of message lines into one message section, markers stripped', () => {
    const entries = foldChat([line(1, 'text', '● First line'), line(2, 'text', '  second line'), line(3, 'text', '  third')]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'message', id: 'm:1', lines: 3 });
    expect(entries[0].text).toBe('First line\nsecond line\nthird');
  });

  it('keeps each tool call its own section', () => {
    const entries = foldChat([line(1, 'tool', '⏺ Read a.ts', 'Read'), line(2, 'result', '  ⎿ Read 3 lines'), line(3, 'tool', '⏺ Edit a.ts', 'Edit')]);
    expect(entries.map((e) => e.kind)).toEqual(['tool', 'result', 'tool']);
    expect(entries[0].tool).toBe('Read');
  });

  it('groups consecutive thinking lines into one thought section whose id is stable as it grows', () => {
    const first = foldChat([line(10, 'thinking', 'The toolbar overflows.'), line(11, 'thinking', 'A flex wrap should fix it.')]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'thought', id: 't:10', lines: 2 });
    expect(first[0].text).toBe('The toolbar overflows.\n\nA flex wrap should fix it.');
    // More thinking stays in the same section (the id comes from the first line).
    const grown = foldChat([line(10, 'thinking', 'The toolbar overflows.'), line(11, 'thinking', 'A flex wrap should fix it.'), line(12, 'thinking', 'Then re-run the tests.')]);
    expect(grown[0].id).toBe('t:10');
    expect(grown[0].lines).toBe(3);
  });

  it('starts a new thought section after other output', () => {
    const entries = foldChat([line(1, 'thinking', 'one'), line(2, 'text', '● done'), line(3, 'thinking', 'two')]);
    expect(entries.map((e) => ({ kind: e.kind, id: e.id }))).toEqual([
      { kind: 'thought', id: 't:1' },
      { kind: 'message', id: 'm:2' },
      { kind: 'thought', id: 't:3' },
    ]);
  });

  it('keeps system, error, manager and done lines as their own sections', () => {
    const entries = foldChat([line(1, 'system', 'trusted'), line(2, 'manager', '▶ typed'), line(3, 'error', '⚠ boom'), line(4, 'done', '✔ finished')]);
    expect(entries.map((e) => e.kind)).toEqual(['system', 'manager', 'error', 'done']);
  });

  it('drops blank message groups but keeps empty results', () => {
    const entries = foldChat([line(1, 'text', '   '), line(2, 'result', '   ')]);
    expect(entries.map((e) => e.kind)).toEqual(['result']);
  });

  it('strips the placeholder marker Claude Code prints before a thought', () => {
    const [entry] = foldChat([line(1, 'thinking', '✻ The API key is missing.')]);
    expect(entry.text).toBe('The API key is missing.');
  });
});

describe('messageText', () => {
  it('keeps a continuation line\'s own indentation after the two-space prefix', () => {
    expect(messageText([line(1, 'text', '● code:'), line(2, 'text', '    const x = 1;')])).toBe('code:\n  const x = 1;');
  });
});

describe('thoughtLabel', () => {
  it('uses the first non-empty line and clips it', () => {
    expect(thoughtLabel('\nLooking at the layout.')).toBe('Looking at the layout.');
    expect(thoughtLabel('x'.repeat(200))).toHaveLength(80);
    expect(thoughtLabel('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('thoughtsSupported', () => {
  it('is on for the CLIs whose output carries reasoning text', () => {
    expect(thoughtsSupported('claude')).toBe(true);
    expect(thoughtsSupported('opencode')).toBe(true);
  });

  it('is off for Codex, whose notify and hooks carry no reasoning', () => {
    expect(thoughtsSupported('codex')).toBe(false);
  });
});
