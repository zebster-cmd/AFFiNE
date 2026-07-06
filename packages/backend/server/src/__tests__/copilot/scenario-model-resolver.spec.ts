import test from 'ava';

import { ScenarioModelResolver } from '../../plugins/copilot/providers/scenario-model-resolver';

function resolver(overrides: unknown) {
  const config = { copilot: { scenarioOverrides: overrides } } as any;
  return new ScenarioModelResolver(config);
}

const ENABLED = {
  enabled: true,
  models: {
    chat: 'requesty/sference/glm-5.2',
    embedding: 'requesty/nebius/Qwen/Qwen3-Embedding-8B',
    rerank: 'requesty/nebius/qwen/qwen3-32b',
  },
};

test('injects the chat model when featureKind is chat and no explicit model', t => {
  const out = resolver(ENABLED).resolve({}, 'chat');
  t.is(out.modelId, 'requesty/sference/glm-5.2');
});

test('maps the action featureKind to the chat scenario', t => {
  const out = resolver(ENABLED).resolve({}, 'action');
  t.is(out.modelId, 'requesty/sference/glm-5.2');
});

test('maps embedding/rerank one-to-one', t => {
  t.is(
    resolver(ENABLED).resolve({}, 'embedding').modelId,
    'requesty/nebius/Qwen/Qwen3-Embedding-8B'
  );
  t.is(
    resolver(ENABLED).resolve({}, 'rerank').modelId,
    'requesty/nebius/qwen/qwen3-32b'
  );
});

test('an explicit model wins over the override', t => {
  const out = resolver(ENABLED).resolve(
    { modelId: 'requesty/openai/gpt-4o' },
    'chat'
  );
  t.is(out.modelId, 'requesty/openai/gpt-4o');
});

test('does nothing when disabled', t => {
  const out = resolver({ enabled: false, models: ENABLED.models }).resolve(
    {},
    'chat'
  );
  t.is(out.modelId, undefined);
});

test('does nothing when the scenario has no configured model', t => {
  const out = resolver(ENABLED).resolve({}, 'image');
  t.is(out.modelId, undefined);
});

test('warnUnknownModels flags scenario models missing from the registry', t => {
  const r = resolver({
    enabled: true,
    models: {
      chat: 'requesty/sference/glm-5.2',
      image: 'requesty/unknown/model',
    },
  });
  const missing = r.warnUnknownModels(new Set(['requesty/sference/glm-5.2']));
  t.deepEqual(missing, ['requesty/unknown/model']);
});
