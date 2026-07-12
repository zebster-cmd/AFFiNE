import { describe, expect, test } from 'vitest';

import {
  getToolCallLabel,
  getToolErrorFromResult,
  getToolFailedLabel,
  getToolResultLabel,
  humanizeToolName,
  toGenericToolResults,
  truncateContent,
} from '../generic-tool-display';

describe('humanizeToolName', () => {
  test('converts snake_case to sentence case', () => {
    expect(humanizeToolName('some_new_tool')).toBe('Some new tool');
  });

  test('handles dashes and repeated separators', () => {
    expect(humanizeToolName('web--map__tool')).toBe('Web map tool');
  });

  test('handles single word', () => {
    expect(humanizeToolName('search')).toBe('Search');
  });

  test('returns input unchanged when only separators', () => {
    expect(humanizeToolName('___')).toBe('___');
  });
});

describe('tool labels', () => {
  test('uses friendly labels for known tools', () => {
    expect(getToolCallLabel('database_read')).toBe('Reading database');
    expect(getToolResultLabel('database_read')).toBe('Read database');
    expect(getToolCallLabel('database_create')).toBe('Creating database');
    expect(getToolResultLabel('database_create')).toBe('Created database');
    expect(getToolCallLabel('database_update')).toBe('Updating database');
    expect(getToolResultLabel('database_update')).toBe('Updated database');
    expect(getToolCallLabel('blob_read')).toBe('Reading attachment');
    expect(getToolResultLabel('blob_read')).toBe('Read attachment');
    expect(getToolCallLabel('conversation_summary')).toBe(
      'Summarizing conversation'
    );
    expect(getToolResultLabel('conversation_summary')).toBe(
      'Conversation summary'
    );
    expect(getToolCallLabel('web_map_tavily')).toBe('Mapping site URLs');
    expect(getToolResultLabel('web_map_tavily')).toBe('Site URL map');
  });

  test('humanizes unknown tools mechanically', () => {
    expect(getToolCallLabel('some_new_tool')).toBe('Some new tool calling');
    expect(getToolResultLabel('some_new_tool')).toBe('Some new tool result');
  });

  test('failed label', () => {
    expect(getToolFailedLabel('database_read')).toBe('Database read failed');
    expect(getToolFailedLabel('some_new_tool')).toBe('Some new tool failed');
  });
});

describe('truncateContent', () => {
  test('leaves short text untouched', () => {
    expect(truncateContent('hello')).toBe('hello');
  });

  test('truncates long text with ellipsis', () => {
    const long = 'a'.repeat(3000);
    const truncated = truncateContent(long);
    expect(truncated.length).toBe(2001);
    expect(truncated.endsWith('…')).toBe(true);
  });

  test('respects custom max length', () => {
    expect(truncateContent('abcdef', 3)).toBe('abc…');
  });
});

describe('getToolErrorFromResult', () => {
  test('detects backend toolError shape', () => {
    const error = {
      type: 'error',
      name: 'DatabaseNotFound',
      message: 'No database block found',
    };
    expect(getToolErrorFromResult(error)).toEqual(error);
  });

  test('returns null for non-error payloads', () => {
    expect(getToolErrorFromResult(null)).toBeNull();
    expect(getToolErrorFromResult({ rows: [] })).toBeNull();
    expect(getToolErrorFromResult([{ type: 'error' }])).toBeNull();
    expect(getToolErrorFromResult('error')).toBeNull();
  });
});

describe('toGenericToolResults', () => {
  test('returns empty for null/undefined', () => {
    expect(toGenericToolResults(null)).toEqual([]);
    expect(toGenericToolResults(undefined)).toEqual([]);
  });

  test('maps arrays of titled items to result entries', () => {
    const result = toGenericToolResults([
      {
        title: 'Page one',
        url: 'https://example.com/1',
        content: 'First page content',
        favicon: 'https://example.com/favicon.ico',
      },
      { name: 'Named item', text: 'Named content' },
    ]);
    expect(result).toEqual([
      {
        title: 'Page one',
        content: 'First page content',
        href: 'https://example.com/1',
        icon: 'https://example.com/favicon.ico',
      },
      {
        title: 'Named item',
        content: 'Named content',
        href: undefined,
        icon: undefined,
      },
    ]);
  });

  test('maps urls payload (web_map_tavily) to link entries', () => {
    const result = toGenericToolResults({
      urls: ['https://a.example.com', 'https://b.example.com'],
    });
    expect(result).toEqual([
      { title: 'https://a.example.com', href: 'https://a.example.com' },
      { title: 'https://b.example.com', href: 'https://b.example.com' },
    ]);
  });

  test('renders an empty urls payload as a friendly entry, not raw JSON', () => {
    expect(toGenericToolResults({ urls: [] })).toEqual([
      { title: 'No URLs found' },
    ]);
  });

  test('renders plain strings as a single entry', () => {
    expect(toGenericToolResults('plain output')).toEqual([
      { title: 'Result', content: 'plain output' },
    ]);
  });

  test('falls back to pretty-printed truncated JSON', () => {
    const payload = { columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] };
    const [entry] = toGenericToolResults(payload);
    expect(entry.title).toBe('Result');
    expect(entry.content).toBe(JSON.stringify(payload, null, 2));
  });

  test('truncates huge JSON payloads', () => {
    const payload = { data: 'x'.repeat(5000) };
    const [entry] = toGenericToolResults(payload);
    expect(entry.content?.length).toBe(2001);
    expect(entry.content?.endsWith('…')).toBe(true);
  });

  test('does not treat arrays of untitled items as titled results', () => {
    const [entry] = toGenericToolResults([{ foo: 1 }, { bar: 2 }]);
    expect(entry.title).toBe('Result');
    expect(entry.content).toContain('"foo": 1');
  });
});
