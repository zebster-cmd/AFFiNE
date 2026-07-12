import test from 'ava';
import type { z } from 'zod';

import { ToolRuntime } from '../../plugins/copilot/runtime/tool-runtime';
import {
  createTavilyCrawlTool,
  createTavilyExtractTool,
  createTavilyMapTool,
  createTavilySearchTool,
} from '../../plugins/copilot/tools';

const CONFIG = { copilot: { tavily: { key: 'tvly-test-key' } } } as any;

type FetchStub = {
  calls: Array<{ url: string; init: RequestInit }>;
};

function stubFetch(
  response: () => Response | Promise<Response>
): FetchStub & { restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchStub['calls'] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return response();
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function execute(tool: ReturnType<typeof createTavilySearchTool>, args: any) {
  return tool.execute!(args, {});
}

// #region search

test.serial('search maps a tavily response to the exa item shape', async t => {
  const fetch = stubFetch(() =>
    jsonResponse({
      query: 'affine',
      results: [
        {
          title: 'AFFiNE',
          url: 'https://affine.pro',
          content: 'A workspace app',
          score: 0.98,
          favicon: 'https://affine.pro/favicon.ico',
          published_date: '2026-01-01',
        },
        {
          title: 'AFFiNE Docs',
          url: 'https://docs.affine.pro',
          content: 'Documentation',
          score: 0.72,
        },
      ],
    })
  );
  try {
    const tool = createTavilySearchTool(CONFIG);
    const result = (await execute(tool, {
      query: 'affine',
      topic: 'news',
      timeRange: 'week',
    })) as any[];

    t.deepEqual(result, [
      {
        title: 'AFFiNE',
        url: 'https://affine.pro',
        content: 'A workspace app',
        favicon: 'https://affine.pro/favicon.ico',
        publishedDate: '2026-01-01',
        author: undefined,
      },
      {
        title: 'AFFiNE Docs',
        url: 'https://docs.affine.pro',
        content: 'Documentation',
        favicon: undefined,
        publishedDate: undefined,
        author: undefined,
      },
    ]);

    t.is(fetch.calls.length, 1);
    t.is(fetch.calls[0].url, 'https://api.tavily.com/search');
    const headers = fetch.calls[0].init.headers as Record<string, string>;
    t.is(headers.Authorization, 'Bearer tvly-test-key');
    const body = JSON.parse(fetch.calls[0].init.body as string);
    t.like(body, {
      query: 'affine',
      topic: 'news',
      time_range: 'week',
      search_depth: 'advanced',
      max_results: 10,
      include_favicon: true,
    });
  } finally {
    fetch.restore();
  }
});

// #endregion

// #region extract

test.serial('extract schema enforces the 5-url cap', t => {
  const tool = createTavilyExtractTool(CONFIG);
  const schema = tool.inputSchema as z.ZodTypeAny;

  t.true(
    schema.safeParse({ urls: ['https://a.com', 'https://b.com'] }).success
  );
  t.false(
    schema.safeParse({
      urls: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`),
    }).success
  );
  t.false(schema.safeParse({ urls: [] }).success);

  const jsonSchema = tool.jsonSchema as any;
  t.is(jsonSchema.properties.urls.maxItems, 5);
});

test.serial('extract maps raw_content to content with truncation', async t => {
  const longContent = 'x'.repeat(150_000);
  const fetch = stubFetch(() =>
    jsonResponse({
      results: [
        {
          url: 'https://example.com/long',
          raw_content: longContent,
          favicon: 'https://example.com/favicon.ico',
        },
      ],
      failed_results: [],
    })
  );
  try {
    const tool = createTavilyExtractTool(CONFIG);
    const result = (await execute(tool, {
      urls: ['https://example.com/long'],
    })) as any[];

    t.is(fetch.calls[0].url, 'https://api.tavily.com/extract');
    t.is(result.length, 1);
    t.is(result[0].url, 'https://example.com/long');
    t.is(result[0].content.length, 100_000);
    t.is(result[0].content, longContent.slice(0, 100_000));
    t.is(result[0].favicon, 'https://example.com/favicon.ico');
    t.is(result[0].publishedDate, undefined);
    t.is(result[0].author, undefined);
  } finally {
    fetch.restore();
  }
});

// #endregion

// #region crawl

test.serial('crawl truncates page content and bounds results', async t => {
  const longContent = 'y'.repeat(50_000);
  const fetch = stubFetch(() =>
    jsonResponse({
      base_url: 'https://docs.example.com',
      results: [
        { url: 'https://docs.example.com/a', raw_content: longContent },
        { url: 'https://docs.example.com/b', raw_content: 'short' },
      ],
    })
  );
  try {
    const tool = createTavilyCrawlTool(CONFIG);
    const result = (await execute(tool, {
      url: 'https://docs.example.com',
      instructions: 'find the API docs',
    })) as any[];

    t.is(fetch.calls[0].url, 'https://api.tavily.com/crawl');
    const body = JSON.parse(fetch.calls[0].init.body as string);
    t.like(body, {
      url: 'https://docs.example.com',
      instructions: 'find the API docs',
      limit: 15,
      max_depth: 2,
    });

    t.is(result.length, 2);
    t.is(result[0].content.length, 20_000);
    t.is(result[0].content, longContent.slice(0, 20_000));
    t.is(result[1].content, 'short');
  } finally {
    fetch.restore();
  }
});

// #endregion

// #region map

test.serial('map caps urls at 100', async t => {
  const urls = Array.from(
    { length: 150 },
    (_, i) => `https://example.com/page-${i}`
  );
  const fetch = stubFetch(() =>
    jsonResponse({ base_url: 'https://example.com', results: urls })
  );
  try {
    const tool = createTavilyMapTool(CONFIG);
    const result = (await execute(tool, {
      url: 'https://example.com',
    })) as { urls: string[] };

    t.is(fetch.calls[0].url, 'https://api.tavily.com/map');
    t.is(result.urls.length, 100);
    t.deepEqual(result.urls, urls.slice(0, 100));
  } finally {
    fetch.restore();
  }
});

test.serial('map accepts object-shaped url entries', async t => {
  const fetch = stubFetch(() =>
    jsonResponse({
      results: [{ url: 'https://example.com/a' }, 'https://example.com/b'],
    })
  );
  try {
    const tool = createTavilyMapTool(CONFIG);
    const result = (await execute(tool, {
      url: 'https://example.com',
    })) as { urls: string[] };

    t.deepEqual(result.urls, [
      'https://example.com/a',
      'https://example.com/b',
    ]);
  } finally {
    fetch.restore();
  }
});

// #endregion

// #region errors

test.serial(
  'a non-OK http response surfaces as a toolError-shaped object',
  async t => {
    const fetch = stubFetch(() =>
      jsonResponse({ detail: 'Unauthorized' }, 401)
    );
    try {
      for (const [create, name] of [
        [createTavilySearchTool, 'Tavily Search Failed'],
        [createTavilyExtractTool, 'Tavily Extract Failed'],
        [createTavilyCrawlTool, 'Tavily Crawl Failed'],
        [createTavilyMapTool, 'Tavily Map Failed'],
      ] as const) {
        const tool = create(CONFIG);
        const result = (await execute(tool, {
          query: 'q',
          urls: ['https://example.com'],
          url: 'https://example.com',
        })) as any;

        t.is(result.type, 'error');
        t.is(result.name, name);
        t.true(result.message.includes('401'));
      }
    } finally {
      fetch.restore();
    }
  }
);

test.serial(
  'a missing api key surfaces as a clear toolError without calling the api',
  async t => {
    const fetch = stubFetch(() => jsonResponse({}));
    try {
      const tool = createTavilySearchTool({
        copilot: { tavily: { key: '' } },
      } as any);
      const result = (await execute(tool, { query: 'q' })) as any;

      t.is(result.type, 'error');
      t.is(result.name, 'Tavily Search Failed');
      t.true(result.message.includes('not configured'));
      t.is(fetch.calls.length, 0);
    } finally {
      fetch.restore();
    }
  }
);

test.serial(
  'extract surfaces a toolError when every url fails to extract',
  async t => {
    const fetch = stubFetch(() =>
      jsonResponse({
        results: [],
        failed_results: [{ url: 'https://a.example.com', error: 'timeout' }],
      })
    );
    try {
      const tool = createTavilyExtractTool(CONFIG);
      const result = (await execute(tool, {
        urls: ['https://a.example.com'],
      })) as any;

      t.is(result.type, 'error');
      t.is(result.name, 'Tavily Extract Failed');
      t.true(result.message.includes('https://a.example.com'));
    } finally {
      fetch.restore();
    }
  }
);

// #endregion

// #region tool-runtime registration

function makeRuntime(copilot: Record<string, unknown>) {
  return new ToolRuntime(
    { copilot } as any, // Config
    {} as any, // PermissionAccess
    {} as any, // CopilotContextService
    {} as any, // DocReader
    {} as any, // DocWriter
    {} as any, // Models
    {} as any, // PromptRuntime
    {} as any, // IndexerService
    {} as any // DatabaseWriter
  );
}

const OPTIONS = { user: 'u1', workspace: 'ws1', tools: ['webSearch'] } as any;

test.serial(
  'tool-runtime registers tavily tools when webSearchProvider is tavily',
  async t => {
    const runtime = makeRuntime({
      webSearchProvider: 'tavily',
      tavily: { key: 'tvly-test-key' },
    });
    const tools = await runtime.getTools(OPTIONS, 'gpt-4o-mini');

    t.truthy(tools.web_search_tavily);
    t.truthy(tools.web_extract_tavily);
    t.truthy(tools.web_crawl_tavily);
    t.truthy(tools.web_map_tavily);
    t.falsy(tools.web_search_exa);
    t.falsy(tools.web_crawl_exa);
  }
);

test.serial(
  'tool-runtime registers exa tools when webSearchProvider is exa or unset',
  async t => {
    for (const copilot of [
      { webSearchProvider: 'exa', exa: { key: 'exa-key' } },
      { exa: { key: 'exa-key' } },
    ]) {
      const runtime = makeRuntime(copilot);
      const tools = await runtime.getTools(OPTIONS, 'gpt-4o-mini');

      t.truthy(tools.web_search_exa);
      t.truthy(tools.web_crawl_exa);
      t.falsy(tools.web_search_tavily);
      t.falsy(tools.web_extract_tavily);
      t.falsy(tools.web_crawl_tavily);
      t.falsy(tools.web_map_tavily);
    }
  }
);

// #endregion
