import test from 'ava';

import { PromptToolsSchema } from '../../plugins/copilot/providers/types';
import { ToolRuntime } from '../../plugins/copilot/runtime/tool-runtime';

test('PromptToolsSchema accepts the three database tool names', t => {
  const result = PromptToolsSchema.parse([
    'databaseRead',
    'databaseCreate',
    'databaseUpdate',
  ]);

  t.deepEqual(result, ['databaseRead', 'databaseCreate', 'databaseUpdate']);
});

test('PromptToolsSchema still rejects an unknown tool name', t => {
  t.throws(() => PromptToolsSchema.parse(['notARealTool']));
});

function makeRuntime() {
  return new ToolRuntime(
    {} as any, // Config
    {} as any, // PermissionAccess
    {} as any, // CopilotContextService
    {} as any, // DocReader
    {} as any, // DocWriter
    {} as any, // Models
    {} as any, // PromptRuntime
    {} as any, // IndexerService
    {} as any, // DatabaseWriter
    {} as any, // DocPropertiesReader
    {} as any, // DocPropertiesWriter
    {} as any, // DocLinksReader
    {} as any // DocLinksWriter
  );
}

const OPTIONS = { user: 'u1', workspace: 'ws1' } as any;

test.serial(
  'getTools exposes database_read ungated regardless of dev/canary env',
  async t => {
    const originalEnv = globalThis.env;
    globalThis.env = { ...originalEnv, dev: false } as any;
    try {
      const runtime = makeRuntime();
      const tools = await runtime.getTools(
        { ...OPTIONS, tools: ['databaseRead'] },
        'gpt-4o-mini'
      );

      t.truthy(tools.database_read);
      t.falsy(tools.database_create);
      t.falsy(tools.database_update);
    } finally {
      globalThis.env = originalEnv;
    }
  }
);

test.serial(
  'getTools omits database_create/database_update when dev/canary is off',
  async t => {
    const originalEnv = globalThis.env;
    globalThis.env = {
      ...originalEnv,
      dev: false,
      namespaces: { ...originalEnv.namespaces, canary: false },
    } as any;
    try {
      const runtime = makeRuntime();
      const tools = await runtime.getTools(
        {
          ...OPTIONS,
          tools: ['databaseRead', 'databaseCreate', 'databaseUpdate'],
        },
        'gpt-4o-mini'
      );

      t.truthy(tools.database_read);
      t.falsy(tools.database_create);
      t.falsy(tools.database_update);
    } finally {
      globalThis.env = originalEnv;
    }
  }
);

test.serial(
  'getTools exposes database_create/database_update under snake_case keys when dev is on',
  async t => {
    const originalEnv = globalThis.env;
    globalThis.env = { ...originalEnv, dev: true } as any;
    try {
      const runtime = makeRuntime();
      const tools = await runtime.getTools(
        {
          ...OPTIONS,
          tools: ['databaseRead', 'databaseCreate', 'databaseUpdate'],
        },
        'gpt-4o-mini'
      );

      t.truthy(tools.database_read);
      t.truthy(tools.database_create);
      t.truthy(tools.database_update);
    } finally {
      globalThis.env = originalEnv;
    }
  }
);
