import test from 'ava';

import type { ModelConditions } from '../../plugins/copilot/providers/types';
import { PromptRuntime } from '../../plugins/copilot/runtime/prompt-runtime';

const RESPONSE_CONTRACT = {
  responseSchemaJson: '{"type":"object"}',
  schemaHash: 'test-hash',
} as any;

function createRuntime(
  captured: { cond?: ModelConditions },
  { requestedModelMatches = true }: { requestedModelMatches?: boolean } = {}
) {
  const prompt = {
    model: 'gemini-2.5-pro',
    optionalModels: [],
    config: {},
  };
  const prompts = {
    get: async () => prompt,
    finish: () => [{ role: 'user', content: 'hello' }],
  } as any;
  const capabilityPolicy = {
    resolvePromptModel: async ({
      defaultModel,
      requestedModelId,
    }: {
      defaultModel: string;
      requestedModelId?: string;
    }) => ({
      selectedModel:
        requestedModelId && requestedModelMatches
          ? requestedModelId
          : defaultModel,
      matchedOptionalModel: !!requestedModelId && requestedModelMatches,
    }),
  } as any;
  const runtime = {
    text: async (cond: ModelConditions) => {
      captured.cond = cond;
      return 'ok';
    },
    generateStructuredValue: async (cond: ModelConditions) => {
      captured.cond = cond;
      return { value: {} };
    },
  } as any;
  return new PromptRuntime(prompts, capabilityPolicy, runtime);
}

test('runText marks the prompt-baked default model as promptDefault', async t => {
  const captured: { cond?: ModelConditions } = {};
  await createRuntime(captured).runText('prompt', {});
  t.is(captured.cond?.modelId, 'gemini-2.5-pro');
  t.is(captured.cond?.modelSource, 'promptDefault');
});

test('runText marks a caller-supplied model as user', async t => {
  const captured: { cond?: ModelConditions } = {};
  await createRuntime(captured).runText(
    'prompt',
    {},
    { modelId: 'gpt-5-mini' }
  );
  t.is(captured.cond?.modelId, 'gpt-5-mini');
  t.is(captured.cond?.modelSource, 'user');
});

test('runText marks a rejected model request that fell back to the prompt default as promptDefault', async t => {
  const captured: { cond?: ModelConditions } = {};
  await createRuntime(captured, { requestedModelMatches: false }).runText(
    'prompt',
    {},
    { modelId: 'not-a-real-model' }
  );
  t.is(captured.cond?.modelId, 'gemini-2.5-pro');
  t.is(captured.cond?.modelSource, 'promptDefault');
});

test('runStructured marks the prompt-baked default model as promptDefault', async t => {
  const captured: { cond?: ModelConditions } = {};
  await createRuntime(captured).runStructured(
    'prompt',
    {},
    { responseContract: RESPONSE_CONTRACT }
  );
  t.is(captured.cond?.modelId, 'gemini-2.5-pro');
  t.is(captured.cond?.modelSource, 'promptDefault');
});

test('runStructured marks a caller-supplied model as user', async t => {
  const captured: { cond?: ModelConditions } = {};
  await createRuntime(captured).runStructured(
    'prompt',
    {},
    { responseContract: RESPONSE_CONTRACT, modelId: 'gpt-5-mini' }
  );
  t.is(captured.cond?.modelId, 'gpt-5-mini');
  t.is(captured.cond?.modelSource, 'user');
});
