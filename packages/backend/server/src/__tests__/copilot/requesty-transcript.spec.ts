import test from 'ava';
import Sinon from 'sinon';

import { ScenarioModelResolver } from '../../plugins/copilot/providers/scenario-model-resolver';
import { CopilotTranscriptionService } from '../../plugins/copilot/transcript/service';

function createScenarioResolver(overrides: unknown) {
  const config = { copilot: { scenarioOverrides: overrides } } as any;
  return new ScenarioModelResolver(config);
}

function createCopilotTranscriptionService(...deps: unknown[]) {
  return new CopilotTranscriptionService(
    deps[0] as never,
    deps[1] as never,
    deps[2] as never,
    deps[3] as never,
    deps[4] as never,
    deps[5] as never,
    (deps[6] ?? {
      assertQuotaOrByok: Sinon.stub().resolves(undefined),
    }) as never,
    (deps[7] ?? { publish: Sinon.stub() }) as never,
    deps[8] as never
  );
}

test('submitTask uses the transcript scenario override model when enabled', async t => {
  const queuedJobs: unknown[] = [];
  const resolveTranscriptionModel = Sinon.stub().resolves('gemini-2.5-flash');
  const scenarioResolver = createScenarioResolver({
    enabled: true,
    models: {
      transcript: 'requesty/mistral/voxtral-mini-latest',
    },
  });
  const service = createCopilotTranscriptionService(
    {
      copilotTranscriptTask: {
        getWithUser: Sinon.stub().resolves(null),
        create: Sinon.stub().resolves({ id: 'task-next' }),
        markRunning: Sinon.stub().resolves({ id: 'task-next' }),
      },
    } as never,
    {
      add: Sinon.stub().callsFake(async (name, payload) => {
        queuedJobs.push({ name, payload });
      }),
    } as never,
    {} as never,
    { resolveTranscriptionModel } as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    scenarioResolver
  );

  await service.submitTask('user-1', 'workspace-1', 'blob-1', []);

  const resolvedTranscriptModelId = (
    queuedJobs[0] as { payload: { modelId: string } }
  ).payload.modelId;
  t.is(resolvedTranscriptModelId, 'requesty/mistral/voxtral-mini-latest');
  Sinon.assert.notCalled(resolveTranscriptionModel);
});

test('submitTask falls back to the default transcription model when the override is absent', async t => {
  const queuedJobs: unknown[] = [];
  const resolveTranscriptionModel = Sinon.stub().resolves('gemini-2.5-flash');
  const scenarioResolver = createScenarioResolver({
    enabled: false,
    models: {},
  });
  const service = createCopilotTranscriptionService(
    {
      copilotTranscriptTask: {
        getWithUser: Sinon.stub().resolves(null),
        create: Sinon.stub().resolves({ id: 'task-next' }),
        markRunning: Sinon.stub().resolves({ id: 'task-next' }),
      },
    } as never,
    {
      add: Sinon.stub().callsFake(async (name, payload) => {
        queuedJobs.push({ name, payload });
      }),
    } as never,
    {} as never,
    { resolveTranscriptionModel } as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    scenarioResolver
  );

  await service.submitTask('user-1', 'workspace-1', 'blob-1', []);

  const resolvedTranscriptModelId = (
    queuedJobs[0] as { payload: { modelId: string } }
  ).payload.modelId;
  t.is(resolvedTranscriptModelId, 'gemini-2.5-flash');
  Sinon.assert.calledOnce(resolveTranscriptionModel);
});
