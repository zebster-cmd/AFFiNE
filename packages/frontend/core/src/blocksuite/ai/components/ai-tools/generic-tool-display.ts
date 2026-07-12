import { isToolError } from './tool-result-utils';
import type { ToolError } from './type';

/**
 * Pure helpers for rendering tools that have no dedicated card component.
 * Kept free of lit/DOM imports so they can be unit tested.
 */

const MAX_GENERIC_CONTENT_LENGTH = 2000;

interface ToolDisplayLabels {
  /** Label while the tool is executing, e.g. "Reading database". */
  call: string;
  /** Label once the tool has finished, e.g. "Read database". */
  result: string;
}

/**
 * Friendly labels for tools that are known but rendered by the generic
 * tool-call-card / tool-result-card fallback.
 */
const KNOWN_TOOL_LABELS: Record<string, ToolDisplayLabels> = {
  database_read: { call: 'Reading database', result: 'Read database' },
  database_create: { call: 'Creating database', result: 'Created database' },
  database_update: { call: 'Updating database', result: 'Updated database' },
  blob_read: { call: 'Reading attachment', result: 'Read attachment' },
  conversation_summary: {
    call: 'Summarizing conversation',
    result: 'Conversation summary',
  },
  web_map_tavily: { call: 'Mapping site URLs', result: 'Site URL map' },
};

/**
 * Mechanically humanize a snake_case tool name into sentence case,
 * e.g. "some_new_tool" -> "Some new tool".
 */
export function humanizeToolName(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, ' ').trim();
  if (!words) {
    return toolName;
  }
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

export function getToolCallLabel(toolName: string): string {
  return (
    KNOWN_TOOL_LABELS[toolName]?.call ?? `${humanizeToolName(toolName)} calling`
  );
}

export function getToolResultLabel(toolName: string): string {
  return (
    KNOWN_TOOL_LABELS[toolName]?.result ??
    `${humanizeToolName(toolName)} result`
  );
}

export function getToolFailedLabel(toolName: string): string {
  return `${humanizeToolName(toolName)} failed`;
}

export interface GenericToolResultItem {
  title: string;
  content?: string;
  href?: string;
  icon?: string;
}

export function truncateContent(
  text: string,
  maxLength = MAX_GENERIC_CONTENT_LENGTH
): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + '…';
}

export function getToolErrorFromResult(result: unknown): ToolError | null {
  return isToolError(result) ? result : null;
}

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as RecordLike;
  }
  return null;
}

function pickString(record: RecordLike, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isTitledItem(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return !!pickString(record, ['title', 'name', 'url']);
}

/**
 * Map an arbitrary tool result payload into entries renderable by
 * tool-result-card. Never returns an empty array for a non-null payload.
 */
export function toGenericToolResults(result: unknown): GenericToolResultItem[] {
  if (result === null || result === undefined) {
    return [];
  }

  // Array of objects with title/content-ish fields, e.g. search results.
  if (
    Array.isArray(result) &&
    result.length > 0 &&
    result.every(isTitledItem)
  ) {
    return result.map(item => {
      const record = item as RecordLike;
      const href = pickString(record, ['url', 'href']);
      const content = pickString(record, [
        'content',
        'text',
        'snippet',
        'summary',
        'description',
      ]);
      return {
        title: pickString(record, ['title', 'name', 'url']) ?? 'Result',
        content: content ? truncateContent(content) : undefined,
        href,
        icon: pickString(record, ['favicon']),
      };
    });
  }

  // URL list payloads, e.g. web_map_tavily -> { urls: string[] }.
  const record = asRecord(result);
  if (record) {
    const urls = record.urls;
    if (Array.isArray(urls) && urls.every(url => typeof url === 'string')) {
      return urls.length > 0
        ? (urls as string[]).map(url => ({ title: url, href: url }))
        : [{ title: 'No URLs found' }];
    }
  }

  if (typeof result === 'string') {
    return [{ title: 'Result', content: truncateContent(result) }];
  }

  return [
    {
      title: 'Result',
      content: truncateContent(JSON.stringify(result, null, 2)),
    },
  ];
}
