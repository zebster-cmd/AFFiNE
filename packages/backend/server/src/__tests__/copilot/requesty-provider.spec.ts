import test from 'ava';

import {
  buildProviderRegistry,
  resolveModel,
} from '../../plugins/copilot/providers/provider-registry';
import { RequestyProvider } from '../../plugins/copilot/providers/requesty';
import { CopilotProviderType } from '../../plugins/copilot/providers/types';

function makeProvider(config: Record<string, unknown>) {
  const p = new RequestyProvider();
  (p as any).AFFiNEConfig = { copilot: { providers: { requesty: config } } };
  return p;
}

test('RequestyProvider has the requesty type', t => {
  t.is(new RequestyProvider().type, CopilotProviderType.Requesty);
});

test('RequestyProvider defaults base_url to Requesty and passes the key', t => {
  const cfg = (makeProvider({ apiKey: 'k' }) as any).createNativeConfig();
  t.is(cfg.base_url, 'https://router.requesty.ai');
  t.is(cfg.auth_token, 'k');
});

test('RequestyProvider always uses the openai_chat backend kind', t => {
  const p = makeProvider({ apiKey: 'k', oldApiStyle: false });
  t.is((p as any).resolveModelBackendKind(), 'openai_chat');
});

test('buildProviderRegistry routes a requesty profile and strips its prefix', t => {
  const registry = buildProviderRegistry({
    profiles: [
      {
        id: 'requesty',
        type: CopilotProviderType.Requesty,
        config: { apiKey: 'k' },
      },
    ],
  });
  const routed = resolveModel({
    registry,
    modelId: 'requesty/sference/glm-5.2',
  });
  t.is(routed.explicitProviderId, 'requesty');
  t.is(routed.modelId, 'sference/glm-5.2');
  t.deepEqual(routed.candidateProviderIds, ['requesty']);
});
