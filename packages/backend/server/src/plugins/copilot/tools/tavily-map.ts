import { z } from 'zod';

import { Config } from '../../../base';
import { toolError } from './error';
import { tavilyFetch } from './tavily';
import { defineTool } from './tool';

const MAX_URLS = 100;

export const createTavilyMapTool = (config: Config) => {
  return defineTool({
    description:
      'Discover the URLs of a website using Tavily without extracting their content. Use this to find out which pages exist on a site before reading them. To get page content, use the web crawl or web extract tools.',
    inputSchema: z.object({
      url: z
        .string()
        .describe('The root URL to map (including http:// or https://)'),
      instructions: z
        .string()
        .optional()
        .describe(
          'Natural language instructions to focus the mapping on relevant pages.'
        ),
    }),
    execute: async ({ url, instructions }) => {
      try {
        const result = await tavilyFetch(config, '/map', {
          url,
          instructions,
          limit: MAX_URLS,
        });
        const urls = ((result.results ?? []) as any[])
          .map(entry => (typeof entry === 'string' ? entry : entry?.url))
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(0, MAX_URLS);
        return { urls };
      } catch (e: any) {
        return toolError('Tavily Map Failed', e.message);
      }
    },
  });
};
