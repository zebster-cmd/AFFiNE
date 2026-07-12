import { z } from 'zod';

import { Config } from '../../../base';
import { toolError } from './error';
import { tavilyFetch, type TavilyWebItem, truncateContent } from './tavily';
import { defineTool } from './tool';

const MAX_CONTENT_CHARACTERS_PER_PAGE = 20_000;

export const createTavilyCrawlTool = (config: Config) => {
  return defineTool({
    description:
      'Crawl a website section starting from a URL using Tavily, following links and returning the content of the discovered pages. Use this to explore a section of a site. To read a few specific known URLs, use the web extract tool; to only discover URLs without content, use the web map tool.',
    inputSchema: z.object({
      url: z
        .string()
        .describe('The root URL to crawl (including http:// or https://)'),
      instructions: z
        .string()
        .optional()
        .describe(
          'Natural language instructions to focus the crawl on relevant pages.'
        ),
    }),
    execute: async ({ url, instructions }) => {
      try {
        const result = await tavilyFetch(config, '/crawl', {
          url,
          instructions,
          limit: 15,
          max_depth: 2,
          include_favicon: true,
        });
        return ((result.results ?? []) as any[]).map(
          (data): TavilyWebItem => ({
            title: data.title,
            url: data.url,
            content: truncateContent(
              data.raw_content,
              MAX_CONTENT_CHARACTERS_PER_PAGE
            ),
            favicon: data.favicon,
            publishedDate: undefined,
            author: undefined,
          })
        );
      } catch (e: any) {
        return toolError('Tavily Crawl Failed', e.message);
      }
    },
  });
};
