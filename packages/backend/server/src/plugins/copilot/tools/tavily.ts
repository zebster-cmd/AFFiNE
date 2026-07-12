import { Config } from '../../../base';

const TAVILY_API_BASE = 'https://api.tavily.com';

/**
 * Result item shape shared with the exa web tools so the frontend
 * `web_search_exa`-style result cards can render tavily results as well.
 */
export interface TavilyWebItem {
  title: string | undefined;
  url: string | undefined;
  content: string | undefined;
  favicon: string | undefined;
  publishedDate: string | undefined;
  author: string | undefined;
}

export async function tavilyFetch(
  config: Config,
  endpoint: '/search' | '/extract' | '/crawl' | '/map',
  body: Record<string, unknown>
): Promise<any> {
  const { key } = config.copilot.tavily;
  if (!key) {
    throw new Error('Tavily API key is not configured');
  }
  const response = await fetch(`${TAVILY_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Tavily API request failed with status ${response.status}${
        detail ? `: ${detail}` : ''
      }`
    );
  }

  return response.json();
}

export function truncateContent(
  content: unknown,
  maxCharacters: number
): string | undefined {
  if (typeof content !== 'string') {
    return undefined;
  }
  return content.length > maxCharacters
    ? content.slice(0, maxCharacters)
    : content;
}
