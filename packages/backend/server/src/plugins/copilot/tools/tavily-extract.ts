import { z } from 'zod';

import { Config } from '../../../base';
import { toolError } from './error';
import { tavilyFetch, type TavilyWebItem, truncateContent } from './tavily';
import { defineTool } from './tool';

const MAX_CONTENT_CHARACTERS = 100_000;

export const createTavilyExtractTool = (config: Config) => {
  return defineTool({
    description:
      'Extract the full content of specific known URLs using Tavily. Use this to read pages you already have the URLs for. To discover sources, use the web search tool instead.',
    inputSchema: z.object({
      urls: z
        .array(
          z
            .string()
            .describe('A URL to extract (including http:// or https://)')
        )
        .min(1)
        .max(5)
        .describe('The URLs to extract content from (at most 5 per call).'),
    }),
    execute: async ({ urls }) => {
      try {
        const result = await tavilyFetch(config, '/extract', {
          urls,
          include_favicon: true,
        });
        const results = (result.results ?? []) as any[];
        const failed = (result.failed_results ?? []) as any[];
        if (!results.length && failed.length) {
          return toolError(
            'Tavily Extract Failed',
            `Could not extract any of the requested URLs: ${failed
              .map(f => f?.url ?? String(f))
              .join(', ')}`
          );
        }
        return results.map(
          (data): TavilyWebItem => ({
            title: data.title,
            url: data.url,
            content: truncateContent(data.raw_content, MAX_CONTENT_CHARACTERS),
            favicon: data.favicon,
            publishedDate: undefined,
            author: undefined,
          })
        );
      } catch (e: any) {
        return toolError('Tavily Extract Failed', e.message);
      }
    },
  });
};
