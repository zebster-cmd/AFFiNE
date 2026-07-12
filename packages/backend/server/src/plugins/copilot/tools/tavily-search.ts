import { z } from 'zod';

import { Config } from '../../../base';
import { toolError } from './error';
import { tavilyFetch, type TavilyWebItem } from './tavily';
import { defineTool } from './tool';

export const createTavilySearchTool = (config: Config) => {
  return defineTool({
    description:
      'Search the web using Tavily, a web search API built for AI. Use this to find sources and up-to-date information on a topic. To read the full content of specific known URLs, use the web extract tool instead.',
    inputSchema: z.object({
      query: z.string().describe('The query to search the web for.'),
      topic: z
        .enum(['general', 'news'])
        .optional()
        .describe(
          'The category of the search. Use "news" for current events and recent coverage, otherwise "general".'
        ),
      timeRange: z
        .enum(['day', 'week', 'month', 'year'])
        .optional()
        .describe(
          'Restrict results to this time range back from the current date.'
        ),
    }),
    execute: async ({ query, topic, timeRange }) => {
      try {
        const result = await tavilyFetch(config, '/search', {
          query,
          topic,
          time_range: timeRange,
          search_depth: 'advanced',
          max_results: 10,
          include_favicon: true,
        });
        return ((result.results ?? []) as any[]).map(
          (data): TavilyWebItem => ({
            title: data.title,
            url: data.url,
            content: data.content,
            favicon: data.favicon,
            publishedDate: data.published_date,
            author: undefined,
          })
        );
      } catch (e: any) {
        return toolError('Tavily Search Failed', e.message);
      }
    },
  });
};
