import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeThinking, codexReasoning, opencodeReasoning, readNewLines } from './thoughts.ts';

// Fixtures in the shape the installed CLIs write (Claude Code 2.1.114, Codex 0.161.0, OpenCode 1.4.10).

const claudeLine = JSON.stringify({
  parentUuid: 'p',
  type: 'assistant',
  isSidechain: false,
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The toolbar overflows at 375px.', signature: 'sig' },
      { type: 'text', text: 'Let me check the styles.' },
    ],
  },
});

describe('claudeThinking', () => {
  it("reads the reasoning text from an assistant message's thinking block", () => {
    expect(claudeThinking(claudeLine)).toEqual(['The toolbar overflows at 375px.']);
  });

  it('ignores text, tool and user lines', () => {
    expect(claudeThinking(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }))).toEqual([]);
    expect(claudeThinking(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toEqual([]);
    expect(claudeThinking(JSON.stringify({ type: 'summary', summary: 'x' }))).toEqual([]);
  });

  it('skips a subagent (sidechain) turn, which never reaches the main screen', () => {
    const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'thinking', thinking: 'sub' }] } });
    expect(claudeThinking(side)).toEqual([]);
  });

  it('skips redacted thinking blocks, which carry no readable text', () => {
    const redacted = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'redacted_thinking', data: 'abc' }] } });
    expect(claudeThinking(redacted)).toEqual([]);
  });

  it('returns nothing for a malformed or blank line', () => {
    expect(claudeThinking('not json')).toEqual([]);
    expect(claudeThinking(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '   ' }] } }))).toEqual([]);
  });
});

describe('codexReasoning', () => {
  it('reads the summary text of a reasoning response item', () => {
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'Consider the auth path.' }] } });
    expect(codexReasoning(line)).toEqual(['Consider the auth path.']);
  });

  it('ignores other response items and blank summaries', () => {
    expect(codexReasoning(JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [] } }))).toEqual([]);
    expect(codexReasoning(JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: ' ' }] } }))).toEqual([]);
  });
});

describe('opencodeReasoning', () => {
  it('reads the reasoning parts of an assistant message', () => {
    const parts = [
      { type: 'reasoning', text: 'The reducer is the right place.' },
      { type: 'text', text: 'Done.' },
      { type: 'reasoning', text: 'Then run the tests.' },
    ];
    expect(opencodeReasoning(parts)).toEqual(['The reducer is the right place.', 'Then run the tests.']);
  });

  it('returns nothing for parts of other kinds or a non-array', () => {
    expect(opencodeReasoning([{ type: 'tool', tool: 'read' }])).toEqual([]);
    expect(opencodeReasoning(undefined)).toEqual([]);
  });
});

describe('readNewLines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-thoughts-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads only the new complete lines and advances the offset', () => {
    const file = path.join(dir, 'grow.jsonl');
    fs.writeFileSync(file, 'a\nb\n');
    const first = readNewLines(file, 0);
    expect(first.lines).toEqual(['a', 'b']);
    expect(first.offset).toBe(4);
    fs.appendFileSync(file, 'c\n');
    const second = readNewLines(file, first.offset);
    expect(second.lines).toEqual(['c']);
    expect(readNewLines(file, second.offset).lines).toEqual([]);
  });

  it('waits for the closing newline of a partial line', () => {
    const file = path.join(dir, 'partial.jsonl');
    fs.writeFileSync(file, 'complete\npartial');
    const r = readNewLines(file, 0);
    expect(r.lines).toEqual(['complete']);
    fs.appendFileSync(file, '\n');
    expect(readNewLines(file, r.offset).lines).toEqual(['partial']);
  });

  it('returns nothing for a file that is not there', () => {
    expect(readNewLines(path.join(dir, 'missing.jsonl'), 0)).toEqual({ lines: [], offset: 0 });
  });
});
