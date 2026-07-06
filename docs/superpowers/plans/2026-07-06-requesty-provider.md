# Requesty Provider + Scenario Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the AFFiNE copilot through the Requesty OpenAI-compatible gateway and let a self-host operator pick which Requesty-routed model backs each AI scenario (chat/image/embedding/rerank/transcript) via server config.

**Architecture:** A thin `RequestyProvider` (subclass of `OpenAIProvider`, forced to the `openai_chat` backend) supplies the Requesty `base_url`/key. A curated set of Requesty models is registered as native registry variants so they pass Affine's registry-gated model resolution. A new `copilot.scenarioOverrides` config + a `ScenarioModelResolver` injects the chosen model at `CopilotProviderFactory.resolveRoutes` (and, for transcription, at the transcript service).

**Tech Stack:** TypeScript (NestJS server, `packages/backend/server`), Rust (napi native, `packages/backend/native`, crate `affine_server_native`), `zod` config schemas, `ava` tests (server), `cargo test` (native).

## Global Constraints

- Backend + native only. No frontend, no BYOK, no GraphQL, no DB migration.
- Requesty base URL default: `https://router.requesty.ai/v1`. All Requesty variants use `backend_kind: "openai_chat"`. Do **not** add a new `backend_kind` enum value.
- Models are referenced as `requesty/<requesty-model-id>` (e.g. `requesty/sference/glm-5.2`).
- Curated models only; unlisted model IDs stay rejected. The five: `sference/glm-5.2` (chat), `nebius/Qwen/Qwen3-Embedding-8B` (embedding), `nebius/qwen/qwen3-32b` (rerank), `vertex/google/gemini-3.1-flash-image-preview` (image), `mistral/voxtral-mini-latest` (transcript).
- Scenario vocabulary (coarse, v1): `chat | image | embedding | rerank | transcript`. featureKind mapping: `chat|action → chat`; `image|embedding|rerank|transcript` 1:1.
- Override precedence: an explicit user-selected `cond.modelId` wins; otherwise the scenario override supplies the model.
- Server single-file test: `yarn workspace @affine/server ava <path>`. Native test: `cd packages/backend/native && cargo test <filter>`.
- Spec: `docs/superpowers/specs/2026-07-06-requesty-provider-design.md`.

---

### Task 0: Spike — registry augmentation feasibility + Requesty endpoint validation

Investigative task. Deliverable: a findings note that (a) decides the Layer 2 mechanism and (b) records go/no-go per modality. Later tasks depend on its outcome.

**Files:**
- Create: `docs/superpowers/specs/2026-07-06-requesty-spike-findings.md`

- [ ] **Step 1: Locate the `llm_adapter` variant type surface**

Run:
```bash
cd packages/backend/native
cargo doc -p llm_adapter --no-deps 2>/dev/null; \
find "$(cargo metadata --format-version=1 | node -e 'const m=JSON.parse(require("fs").readFileSync(0));const p=m.packages.find(x=>x.name==="llm_adapter");console.log(require("path").dirname(p.manifest_path))')" -name '*.rs' | xargs grep -ln 'ModelRegistryVariant\|default_model_registry_variants'
```
Open the files listed. Record: is `pub struct ModelRegistryVariant` — does it derive `Deserialize`? Are its fields `pub`? Is there a public constructor? Does `default_model_registry_variants()` return an owned `Vec<ModelRegistryVariant>`? Does `resolve_model_registry_variant` / `select_model_registry_variant` accept `&[ModelRegistryVariant]`?

- [ ] **Step 2: Decide the mechanism and write it down**

In the findings note, record ONE of:
- **A (in-repo, preferred):** `ModelRegistryVariant` is constructible (derives `Deserialize`, or public fields/ctor) AND the resolve/select functions accept an externally-built slice. → Layer 2 appends variants inside `packages/backend/native`.
- **B (fork):** it is not externally constructible. → Layer 2 uses the `[patch.crates-io]` override in `Cargo.toml` + `.cargo/config.toml` to point `llm_adapter` at a local checkout, and adds variants there.

- [ ] **Step 3: Prove the mechanism with a throwaway variant**

For mechanism A, add a temporary test to `packages/backend/native/src/llm/core/model_registry.rs` that builds one variant for `requesty/spike/echo` and asserts it resolves:
```rust
#[test]
fn spike_can_append_variant() {
  // Build via whichever path Step 1 confirmed (serde_json::from_value or struct literal).
  let mut variants = llm_adapter::core::default_model_registry_variants().to_vec();
  let extra: llm_adapter::core::ModelRegistryVariant = serde_json::from_value(serde_json::json!({
    "backendKind": "openai_chat",
    "canonicalKey": "spike/echo",
    "rawModelId": "spike/echo",
    "aliases": ["spike/echo"],
    "capabilities": [{ "input": ["text"], "output": ["text"] }]
  })).unwrap();
  variants.push(extra);
  let hit = llm_adapter::core::resolve_model_registry_variant(&variants, Some("openai_chat"), "spike/echo").unwrap();
  assert!(hit.is_some());
}
```
Run: `cargo test -p affine_server_native spike_can_append_variant`
Expected: PASS (mechanism A) or a compile error revealing the true construction API (adjust and record it). If genuinely impossible, switch to mechanism B and validate the patch builds. **Delete the throwaway test before finishing.**

- [ ] **Step 4: Validate each modality against a live Requesty endpoint**

Using a real key in `$REQUESTY_KEY`, confirm which endpoints Requesty actually serves OpenAI-compatibly:
```bash
BASE=https://router.requesty.ai/v1
# chat
curl -s $BASE/chat/completions -H "Authorization: Bearer $REQUESTY_KEY" -H 'content-type: application/json' \
  -d '{"model":"sference/glm-5.2","messages":[{"role":"user","content":"ping"}]}' | head -c 400; echo
# embedding
curl -s $BASE/embeddings -H "Authorization: Bearer $REQUESTY_KEY" -H 'content-type: application/json' \
  -d '{"model":"nebius/Qwen/Qwen3-Embedding-8B","input":"hello"}' | head -c 400; echo
# image (may 404 / unsupported)
curl -s $BASE/images/generations -H "Authorization: Bearer $REQUESTY_KEY" -H 'content-type: application/json' \
  -d '{"model":"vertex/google/gemini-3.1-flash-image-preview","prompt":"a cat"}' | head -c 400; echo
# transcription (multipart; may 404 / unsupported)
curl -s $BASE/audio/transcriptions -H "Authorization: Bearer $REQUESTY_KEY" \
  -F model=mistral/voxtral-mini-latest -F file=@/path/to/sample.wav | head -c 400; echo
```
Record per modality: **served / not served**. Rerank has no dedicated endpoint (LLM-based) — mark it served iff the chat probe with `nebius/qwen/qwen3-32b` returns a completion.

- [ ] **Step 5: Commit the findings note**

```bash
git add docs/superpowers/specs/2026-07-06-requesty-spike-findings.md
git commit -m "docs: requesty spike findings (registry mechanism + endpoint validation)"
```

---

### Task 1: Requesty provider type, class, config, and registration

**Files:**
- Modify: `packages/backend/server/src/plugins/copilot/providers/types.ts` (add enum value)
- Create: `packages/backend/server/src/plugins/copilot/providers/requesty.ts`
- Modify: `packages/backend/server/src/plugins/copilot/providers/provider-tokens.ts`
- Modify: `packages/backend/server/src/plugins/copilot/providers/index.ts` (export, if it re-exports providers)
- Modify: `packages/backend/server/src/plugins/copilot/providers/provider-registry.ts` (`LEGACY_PROVIDER_ORDER`)
- Modify: `packages/backend/server/src/plugins/copilot/config.ts` (config map, zod, AppConfigSchema, defineModuleConfig)
- Test: `packages/backend/server/src/__tests__/copilot/requesty-provider.spec.ts`

**Interfaces:**
- Consumes: `OpenAIProvider`, `OpenAIConfig` from `./openai`; `CopilotProviderType` from `./types`; `buildProviderRegistry` from `./provider-registry`.
- Produces: `CopilotProviderType.Requesty = 'requesty'`; `class RequestyProvider extends OpenAIProvider`; config path `copilot.providers.requesty` typed `OpenAIConfig`.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/server/src/__tests__/copilot/requesty-provider.spec.ts`:
```ts
import test from 'ava';

import { RequestyProvider } from '../../plugins/copilot/providers/requesty';
import { buildProviderRegistry } from '../../plugins/copilot/providers/provider-registry';
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
      { id: 'requesty', type: CopilotProviderType.Requesty, config: { apiKey: 'k' } },
    ],
  });
  const routed = (require('../../plugins/copilot/providers/provider-registry') as any).resolveModel({
    registry,
    modelId: 'requesty/sference/glm-5.2',
  });
  t.is(routed.explicitProviderId, 'requesty');
  t.is(routed.modelId, 'sference/glm-5.2');
  t.deepEqual(routed.candidateProviderIds, ['requesty']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/requesty-provider.spec.ts`
Expected: FAIL — cannot find module `./requesty` / `RequestyProvider` undefined.

- [ ] **Step 3: Add the enum value**

In `providers/types.ts`, add to `CopilotProviderType`:
```ts
export enum CopilotProviderType {
  Anthropic = 'anthropic',
  AnthropicVertex = 'anthropicVertex',
  CloudflareWorkersAi = 'cloudflareWorkersAi',
  FAL = 'fal',
  Gemini = 'gemini',
  GeminiVertex = 'geminiVertex',
  OpenAI = 'openai',
  Requesty = 'requesty',
}
```

- [ ] **Step 4: Create the provider class**

Create `providers/requesty.ts`:
```ts
import type { LlmBackendConfig } from '../../../native';
import { OpenAIProvider } from './openai';
import type { CopilotProviderExecution } from './provider-runtime-contract';
import { CopilotProviderType } from './types';

const REQUESTY_DEFAULT_BASE_URL = 'https://router.requesty.ai/v1';

export class RequestyProvider extends OpenAIProvider {
  override readonly type = CopilotProviderType.Requesty;

  // Requesty speaks OpenAI Chat Completions; ignore oldApiStyle.
  protected override resolveModelBackendKind() {
    return 'openai_chat' as const;
  }

  protected override createNativeConfig(
    execution?: CopilotProviderExecution
  ): LlmBackendConfig {
    const config = this.getConfig(execution);
    const baseUrl = config.baseURL || REQUESTY_DEFAULT_BASE_URL;
    return {
      base_url: baseUrl.replace(/\/v1\/?$/, ''),
      auth_token: config.apiKey,
    };
  }
}
```

- [ ] **Step 5: Register the provider**

In `providers/provider-tokens.ts`:
```ts
import { OpenAIProvider } from './openai';
import { RequestyProvider } from './requesty';

export const CopilotProviders = [
  OpenAIProvider,
  CloudflareWorkersAIProvider,
  FalProvider,
  GeminiGenerativeProvider,
  GeminiVertexProvider,
  AnthropicOfficialProvider,
  AnthropicVertexProvider,
  RequestyProvider,
];
```
In `providers/provider-registry.ts`, add to `LEGACY_PROVIDER_ORDER` (append at end):
```ts
const LEGACY_PROVIDER_ORDER: CopilotProviderType[] = [
  CopilotProviderType.OpenAI,
  CopilotProviderType.CloudflareWorkersAi,
  CopilotProviderType.FAL,
  CopilotProviderType.Gemini,
  CopilotProviderType.GeminiVertex,
  CopilotProviderType.Anthropic,
  CopilotProviderType.AnthropicVertex,
  CopilotProviderType.Requesty,
];
```
If `providers/index.ts` re-exports each provider, add `export * from './requesty';` (match existing export style).

- [ ] **Step 6: Wire config**

In `config.ts`:
- Add to `CopilotProviderConfigMap`:
```ts
[CopilotProviderType.Requesty]: OpenAIConfig;
```
- Add a zod shape (reuse OpenAI shape) and a discriminated-union entry:
```ts
const RequestyConfigShape = OpenAIConfigShape;
// ...inside CopilotProviderProfileShape discriminatedUnion array:
CopilotProviderProfileBaseShape.extend({
  type: z.literal(CopilotProviderType.Requesty),
  config: RequestyConfigShape,
}),
```
- Add to `AppConfigSchema.copilot.providers`:
```ts
requesty: ConfigItem<OpenAIConfig>;
```
- Add to `defineModuleConfig('copilot', { ... })`:
```ts
'providers.requesty': {
  desc: 'The config for the Requesty gateway provider (OpenAI-compatible).',
  default: {
    apiKey: '',
    baseURL: 'https://router.requesty.ai/v1',
  },
},
```

- [ ] **Step 7: Run test to verify it passes**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/requesty-provider.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Typecheck**

Run: `yarn workspace @affine/server exec tsc --noEmit`
Expected: no new type errors (the `CopilotProviderConfigMap` / discriminated-union additions must compile).

- [ ] **Step 9: Commit**

```bash
git add packages/backend/server/src/plugins/copilot/providers/types.ts \
  packages/backend/server/src/plugins/copilot/providers/requesty.ts \
  packages/backend/server/src/plugins/copilot/providers/provider-tokens.ts \
  packages/backend/server/src/plugins/copilot/providers/provider-registry.ts \
  packages/backend/server/src/plugins/copilot/providers/index.ts \
  packages/backend/server/src/plugins/copilot/config.ts \
  packages/backend/server/src/__tests__/copilot/requesty-provider.spec.ts
git commit -m "feat(copilot): add Requesty provider type, class, config, and registration"
```

---

### Task 2: Native curated variants — text + embedding

Applies mechanism from Task 0. Steps below show **mechanism A** (in-repo append). If Task 0 selected mechanism B, the same variant JSON becomes struct literals in the forked crate and the append happens there instead; the tests are identical.

**Files:**
- Modify: `packages/backend/native/src/llm/core/model_registry.rs`

**Interfaces:**
- Produces: `openai_chat` registry variants resolvable by canonical key `sference/glm-5.2` and `nebius/Qwen/Qwen3-Embedding-8B`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `model_registry.rs`:
```rust
#[test]
fn should_resolve_requesty_text_variant() {
  let variants = super::requesty_registry_variants_for_test();
  let hit = llm_adapter::core::resolve_model_registry_variant(&variants, Some("openai_chat"), "sference/glm-5.2")
    .unwrap();
  assert!(hit.is_some());
}

#[test]
fn should_resolve_requesty_embedding_variant() {
  let variants = super::requesty_registry_variants_for_test();
  let hit = llm_adapter::core::resolve_model_registry_variant(
    &variants, Some("openai_chat"), "nebius/Qwen/Qwen3-Embedding-8B").unwrap();
  let (variant, _) = hit.expect("embedding variant resolves");
  assert!(variant.capabilities.iter().any(|c| c.output.iter().any(|o| o == "embedding")));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend/native && cargo test should_resolve_requesty`
Expected: FAIL — `requesty_registry_variants_for_test` / `requesty_registry_variants` not found.

- [ ] **Step 3: Add the variant builder + merge it into the default list**

In `model_registry.rs`, add (construction path per Task 0 findings — `from_value` shown for mechanism A):
```rust
fn requesty_registry_variants() -> Vec<llm_adapter::core::ModelRegistryVariant> {
  let defs = serde_json::json!([
    {
      "backendKind": "openai_chat",
      "canonicalKey": "sference/glm-5.2",
      "rawModelId": "sference/glm-5.2",
      "displayName": "Requesty GLM 5.2",
      "aliases": ["sference/glm-5.2"],
      "capabilities": [
        { "input": ["text"], "output": ["text", "object", "structured"] }
      ]
    },
    {
      "backendKind": "openai_chat",
      "canonicalKey": "nebius/Qwen/Qwen3-Embedding-8B",
      "rawModelId": "nebius/Qwen/Qwen3-Embedding-8B",
      "displayName": "Requesty Qwen3 Embedding 8B",
      "aliases": ["nebius/Qwen/Qwen3-Embedding-8B"],
      "capabilities": [
        { "input": ["text"], "output": ["embedding"] }
      ]
    }
  ]);
  serde_json::from_value(defs).expect("valid requesty variant definitions")
}

#[cfg(test)]
pub(crate) fn requesty_registry_variants_for_test() -> Vec<llm_adapter::core::ModelRegistryVariant> {
  requesty_registry_variants()
}

fn all_registry_variants() -> Vec<llm_adapter::core::ModelRegistryVariant> {
  let mut variants = llm_adapter::core::default_model_registry_variants().to_vec();
  variants.extend(requesty_registry_variants());
  variants
}
```
Then replace the two call sites in `llm_resolve_model_registry_variant` and `llm_match_model_registry` that read `llm_adapter::core::default_model_registry_variants()` with `all_registry_variants()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/backend/native && cargo test should_resolve_requesty`
Expected: PASS (2 tests). Also run the whole module: `cargo test model_registry` — existing 7 tests still PASS.

- [ ] **Step 5: Build the native module**

Run: `yarn workspace @affine/server-native build:debug` (or the repo's native build) to regenerate the `.node` binding consumed by the server.
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/native/src/llm/core/model_registry.rs
git commit -m "feat(native): register curated Requesty text + embedding registry variants"
```

---

### Task 3: `copilot.scenarioOverrides` config + `ScenarioModelResolver` + injection

**Files:**
- Modify: `packages/backend/server/src/plugins/copilot/config.ts` (scenarioOverrides schema)
- Create: `packages/backend/server/src/plugins/copilot/providers/scenario-model-resolver.ts`
- Modify: `packages/backend/server/src/plugins/copilot/providers/factory.ts` (inject + apply in `resolveRoutes`)
- Test: `packages/backend/server/src/__tests__/copilot/scenario-model-resolver.spec.ts`

**Interfaces:**
- Consumes: `Config` from `../../../base`; `CopilotAccessContext` from `../access`; `ModelFullConditions` from `./types`.
- Produces: `class ScenarioModelResolver { resolve(cond: ModelFullConditions, featureKind?: string): ModelFullConditions }`; config path `copilot.scenarioOverrides = { enabled: boolean; models: Partial<Record<'chat'|'image'|'embedding'|'rerank'|'transcript', string>> }`.

- [ ] **Step 1: Write the failing test**

Create `scenario-model-resolver.spec.ts`:
```ts
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
  t.is(resolver(ENABLED).resolve({}, 'embedding').modelId, 'requesty/nebius/Qwen/Qwen3-Embedding-8B');
  t.is(resolver(ENABLED).resolve({}, 'rerank').modelId, 'requesty/nebius/qwen/qwen3-32b');
});

test('an explicit model wins over the override', t => {
  const out = resolver(ENABLED).resolve({ modelId: 'requesty/openai/gpt-4o' }, 'chat');
  t.is(out.modelId, 'requesty/openai/gpt-4o');
});

test('does nothing when disabled', t => {
  const out = resolver({ enabled: false, models: ENABLED.models }).resolve({}, 'chat');
  t.is(out.modelId, undefined);
});

test('does nothing when the scenario has no configured model', t => {
  const out = resolver(ENABLED).resolve({}, 'image');
  t.is(out.modelId, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/scenario-model-resolver.spec.ts`
Expected: FAIL — cannot find module `scenario-model-resolver`.

- [ ] **Step 3: Add the config schema**

In `config.ts`, extend `AppConfigSchema.copilot` with:
```ts
scenarioOverrides: ConfigItem<{
  enabled: boolean;
  models: Partial<
    Record<'chat' | 'image' | 'embedding' | 'rerank' | 'transcript', string>
  >;
}>;
```
And add to `defineModuleConfig('copilot', { ... })`:
```ts
scenarioOverrides: {
  desc: 'Override which model backs each AI scenario (routed via a provider such as Requesty).',
  default: { enabled: false, models: {} },
  shape: z.object({
    enabled: z.boolean(),
    models: z
      .object({
        chat: z.string().optional(),
        image: z.string().optional(),
        embedding: z.string().optional(),
        rerank: z.string().optional(),
        transcript: z.string().optional(),
      })
      .partial(),
  }),
},
```

- [ ] **Step 4: Implement the resolver**

Create `providers/scenario-model-resolver.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';

import { Config } from '../../../base';
import type { ModelFullConditions } from './types';

type Scenario = 'chat' | 'image' | 'embedding' | 'rerank' | 'transcript';

const FEATURE_KIND_TO_SCENARIO: Record<string, Scenario> = {
  chat: 'chat',
  action: 'chat',
  image: 'image',
  embedding: 'embedding',
  rerank: 'rerank',
  transcript: 'transcript',
};

@Injectable()
export class ScenarioModelResolver {
  @Inject() private readonly AFFiNEConfig!: Config;

  // Test constructor injection convenience.
  constructor(config?: Config) {
    if (config) {
      this.AFFiNEConfig = config;
    }
  }

  modelForFeatureKind(featureKind?: string): string | undefined {
    const overrides = this.AFFiNEConfig.copilot.scenarioOverrides;
    if (!overrides?.enabled || !featureKind) {
      return undefined;
    }
    const scenario = FEATURE_KIND_TO_SCENARIO[featureKind];
    return scenario ? overrides.models[scenario] : undefined;
  }

  resolve(
    cond: ModelFullConditions,
    featureKind?: string
  ): ModelFullConditions {
    if (cond.modelId) {
      return cond;
    }
    const modelId = this.modelForFeatureKind(featureKind);
    return modelId ? { ...cond, modelId } : cond;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/scenario-model-resolver.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Inject into the factory and apply in `resolveRoutes`**

In `providers/factory.ts`:
- Add the import and constructor param:
```ts
import { ScenarioModelResolver } from './scenario-model-resolver';
// ...
constructor(
  private readonly server: ServerService,
  private readonly registries: CopilotProviderRegistryService,
  private readonly access: CopilotAccessPolicy,
  private readonly scenarioResolver: ScenarioModelResolver
) {}
```
- At the top of `resolveRoutes`, before `getEffectiveRegistry`:
```ts
cond = this.scenarioResolver.resolve(cond, context.featureKind);
```
(`context.featureKind` is on `CopilotAccessContext`.)

- [ ] **Step 7: Register the resolver as a provider**

Add `ScenarioModelResolver` to the copilot providers module `providers` array (same module that provides `CopilotProviderFactory`). Locate it:
```bash
grep -rl "CopilotProviderFactory" packages/backend/server/src/plugins/copilot/**/*.module.ts
```
Add `ScenarioModelResolver` to that module's `providers: [...]`.

- [ ] **Step 8: Typecheck + run the copilot provider suite**

Run:
```bash
yarn workspace @affine/server exec tsc --noEmit
yarn workspace @affine/server ava src/__tests__/copilot/scenario-model-resolver.spec.ts src/__tests__/copilot/provider-registry.spec.ts
```
Expected: no type errors; all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/backend/server/src/plugins/copilot/config.ts \
  packages/backend/server/src/plugins/copilot/providers/scenario-model-resolver.ts \
  packages/backend/server/src/plugins/copilot/providers/factory.ts \
  packages/backend/server/src/__tests__/copilot/scenario-model-resolver.spec.ts
# plus the module file edited in Step 7
git commit -m "feat(copilot): add scenarioOverrides config and scenario model injection"
```

---

### Task 4: Config-load validation warning for scenario models

**Files:**
- Modify: `packages/backend/server/src/plugins/copilot/providers/scenario-model-resolver.ts`
- Test: `packages/backend/server/src/__tests__/copilot/scenario-model-resolver.spec.ts` (extend)

**Interfaces:**
- Produces: `ScenarioModelResolver.warnUnknownModels(known: Set<string>): string[]` returning the list of configured scenario models absent from `known` (also logged).

- [ ] **Step 1: Write the failing test**

Append to `scenario-model-resolver.spec.ts`:
```ts
test('warnUnknownModels flags scenario models missing from the registry', t => {
  const r = resolver({
    enabled: true,
    models: { chat: 'requesty/sference/glm-5.2', image: 'requesty/unknown/model' },
  });
  const missing = r.warnUnknownModels(new Set(['requesty/sference/glm-5.2']));
  t.deepEqual(missing, ['requesty/unknown/model']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/scenario-model-resolver.spec.ts`
Expected: FAIL — `warnUnknownModels` is not a function.

- [ ] **Step 3: Implement the method**

Add to `ScenarioModelResolver`:
```ts
import { Logger } from '@nestjs/common';
// ...
private readonly logger = new Logger(ScenarioModelResolver.name);

warnUnknownModels(known: Set<string>): string[] {
  const overrides = this.AFFiNEConfig.copilot.scenarioOverrides;
  if (!overrides?.enabled) {
    return [];
  }
  const missing = Object.values(overrides.models).filter(
    (m): m is string => !!m && !known.has(m)
  );
  for (const m of missing) {
    this.logger.warn(
      `scenarioOverrides model "${m}" is not in the copilot model registry; requests for it will fail.`
    );
  }
  return missing;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/scenario-model-resolver.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/server/src/plugins/copilot/providers/scenario-model-resolver.ts \
  packages/backend/server/src/__tests__/copilot/scenario-model-resolver.spec.ts
git commit -m "feat(copilot): warn on scenarioOverrides models missing from the registry"
```

---

### Task 5: Native curated variant — rerank

Only if Task 0 Step 4 marked rerank **served**. Rerank is LLM-based (chat completions), so the variant needs `text → text` capability under `openai_chat` plus the `rerank` output capability that Affine's rerank path selects on.

**Files:**
- Modify: `packages/backend/native/src/llm/core/model_registry.rs`

- [ ] **Step 1: Write the failing test**

Add to the tests module:
```rust
#[test]
fn should_resolve_requesty_rerank_variant() {
  let variants = super::requesty_registry_variants_for_test();
  let hit = llm_adapter::core::resolve_model_registry_variant(
    &variants, Some("openai_chat"), "nebius/qwen/qwen3-32b").unwrap();
  let (variant, _) = hit.expect("rerank variant resolves");
  assert!(variant.capabilities.iter().any(|c| c.output.iter().any(|o| o == "rerank")));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend/native && cargo test should_resolve_requesty_rerank_variant`
Expected: FAIL — variant not found.

- [ ] **Step 3: Add the rerank variant**

In `requesty_registry_variants()`, add to the JSON array:
```json
{
  "backendKind": "openai_chat",
  "canonicalKey": "nebius/qwen/qwen3-32b",
  "rawModelId": "nebius/qwen/qwen3-32b",
  "displayName": "Requesty Qwen3 32B (reranker)",
  "aliases": ["nebius/qwen/qwen3-32b"],
  "capabilities": [
    { "input": ["text"], "output": ["text", "rerank"] }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/backend/native && cargo test should_resolve_requesty` — all PASS.

- [ ] **Step 5: Rebuild native + commit**

```bash
yarn workspace @affine/server-native build:debug
git add packages/backend/native/src/llm/core/model_registry.rs
git commit -m "feat(native): register curated Requesty rerank variant"
```

---

### Task 6: Native curated variant — image

Only if Task 0 Step 4 marked image **served**. The variant's `protocol`/`request_layer` must match what Affine's image path emits and what Requesty accepts (finalized from Task 0 findings — `openai_images` is the OpenAI-compatible default).

**Files:**
- Modify: `packages/backend/native/src/llm/core/model_registry.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn should_resolve_requesty_image_variant() {
  let variants = super::requesty_registry_variants_for_test();
  let hit = llm_adapter::core::resolve_model_registry_variant(
    &variants, Some("openai_chat"), "vertex/google/gemini-3.1-flash-image-preview").unwrap();
  let (variant, _) = hit.expect("image variant resolves");
  assert!(variant.capabilities.iter().any(|c| c.output.iter().any(|o| o == "image")));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend/native && cargo test should_resolve_requesty_image_variant`
Expected: FAIL.

- [ ] **Step 3: Add the image variant**

Add to the JSON array (set `protocol`/`request_layer` per Task 0 findings):
```json
{
  "backendKind": "openai_chat",
  "canonicalKey": "vertex/google/gemini-3.1-flash-image-preview",
  "rawModelId": "vertex/google/gemini-3.1-flash-image-preview",
  "displayName": "Requesty Gemini 3.1 Flash Image",
  "aliases": ["vertex/google/gemini-3.1-flash-image-preview"],
  "protocol": "openai_images",
  "requestLayer": "openai_images",
  "capabilities": [
    { "input": ["text", "image"], "output": ["image"] }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/backend/native && cargo test should_resolve_requesty` — all PASS.

- [ ] **Step 5: Rebuild native + commit**

```bash
yarn workspace @affine/server-native build:debug
git add packages/backend/native/src/llm/core/model_registry.rs
git commit -m "feat(native): register curated Requesty image variant"
```

---

### Task 7: Transcript — variant + transcript-service wiring

Only if Task 0 Step 4 marked transcript **served**. Transcription runs in the separate `plugins/copilot/transcript/` subsystem, so a registry variant is necessary but not sufficient — the transcript service's model selection must consult the `transcript` scenario override.

**Files:**
- Modify: `packages/backend/native/src/llm/core/model_registry.rs` (variant)
- Modify: `packages/backend/server/src/plugins/copilot/transcript/service.ts` (model selection)
- Test: `packages/backend/server/src/__tests__/copilot/transcript-contract.spec.ts` (extend) or a new `requesty-transcript.spec.ts`

- [ ] **Step 1: Add the transcript variant (native)**

Add to `requesty_registry_variants()`:
```json
{
  "backendKind": "openai_chat",
  "canonicalKey": "mistral/voxtral-mini-latest",
  "rawModelId": "mistral/voxtral-mini-latest",
  "displayName": "Requesty Voxtral Mini (transcription)",
  "aliases": ["mistral/voxtral-mini-latest"],
  "capabilities": [
    { "input": ["audio"], "output": ["text"] }
  ]
}
```
Add a resolve test mirroring Task 5 Step 1 (`should_resolve_requesty_transcript_variant`, asserting `input` contains `audio`). Run `cargo test should_resolve_requesty` → PASS. Rebuild native.

- [ ] **Step 2: Find the transcript model-selection point**

Run:
```bash
grep -n "model" packages/backend/server/src/plugins/copilot/transcript/service.ts | head -40
```
Identify where the transcription model id is chosen (constant, prompt, or config). Record the exact line.

- [ ] **Step 3: Write the failing test**

Create `packages/backend/server/src/__tests__/copilot/requesty-transcript.spec.ts` asserting that, with `scenarioOverrides.enabled` and `models.transcript = 'requesty/mistral/voxtral-mini-latest'`, the transcript service resolves that model id. Model the harness on the existing `transcript-contract.spec.ts` setup (config + service instantiation). Include the concrete assertion:
```ts
t.is(resolvedTranscriptModelId, 'requesty/mistral/voxtral-mini-latest');
```

- [ ] **Step 4: Run test to verify it fails**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/requesty-transcript.spec.ts`
Expected: FAIL (service still uses its hard-coded/default model).

- [ ] **Step 5: Wire the override into the transcript service**

At the line found in Step 2, consult `ScenarioModelResolver.modelForFeatureKind('transcript')` (inject the resolver into the transcript service constructor) and use it when present; otherwise keep the existing default.

- [ ] **Step 6: Run test to verify it passes**

Run: `yarn workspace @affine/server ava src/__tests__/copilot/requesty-transcript.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/native/src/llm/core/model_registry.rs \
  packages/backend/server/src/plugins/copilot/transcript/service.ts \
  packages/backend/server/src/__tests__/copilot/requesty-transcript.spec.ts
git commit -m "feat(copilot): route transcription through the transcript scenario override"
```

---

### Task 8: End-to-end verification + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-07-06-requesty-provider-design.md` (mark modality outcomes) or a short operator note.

- [ ] **Step 1: Full copilot suite**

Run: `yarn workspace @affine/server test:copilot`
Expected: all copilot specs PASS.

- [ ] **Step 2: Native suite**

Run: `cd packages/backend/native && cargo test model_registry`
Expected: existing 7 + new Requesty resolve tests PASS.

- [ ] **Step 3: Manual smoke (real key)**

With `copilot.enabled`, `providers.requesty.apiKey`, and `scenarioOverrides.enabled` set, start the server and drive one chat turn; confirm (server logs / network) the request hits `router.requesty.ai` with `sference/glm-5.2`. Confirm an embedding call resolves the embedding scenario model.

- [ ] **Step 4: Record modality outcomes**

In the design doc's §3 table, mark each of image/rerank/transcript as shipped or documented-limitation per the Task 0 validation and the tests that landed.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-06-requesty-provider-design.md
git commit -m "docs: record Requesty modality outcomes after implementation"
```

---

## Self-Review

**Spec coverage:**
- Layer 1 (RequestyProvider + config) → Task 1. ✅
- Layer 2 (curated variants, spike-gated) → Task 0 (mechanism) + Tasks 2/5/6/7 (variants). ✅
- Layer 3 (scenarioOverrides + resolver + injection) → Task 3; config-load validation → Task 4. ✅
- All five modalities in v1 → text/embedding (Task 2), rerank (Task 5), image (Task 6), transcript (Task 7), each gated on Task 0 endpoint validation. ✅
- Error handling (missing key → not registered; unknown model → warn + CopilotPromptInvalid; Requesty errors → OpenAI handler) → Task 1 (registration), Task 4 (warn), inherited from OpenAIProvider. ✅
- Testing (native resolve tests, resolver unit tests, e2e smoke) → Tasks 2–8. ✅

**Placeholder scan:** Native variant `protocol`/`request_layer` for image (Task 6) and the transcript service selection line (Task 7 Step 2) are resolved from Task 0 findings / a grep, not left as "TBD" — each has a concrete discovery step. No `TODO`/`fill-in` steps remain.

**Type consistency:** `requesty_registry_variants()` / `requesty_registry_variants_for_test()` / `all_registry_variants()` used consistently across Tasks 2, 5, 6, 7. `ScenarioModelResolver.resolve` / `modelForFeatureKind` / `warnUnknownModels` signatures match between Tasks 3, 4, 7. `CopilotProviderType.Requesty` and config path `copilot.providers.requesty` / `copilot.scenarioOverrides` consistent throughout.

**Known dependency:** Tasks 2/5/6/7 assume Task 0 selects mechanism A (in-repo append). If mechanism B (fork) is chosen, the variant JSON is identical but lives in the forked crate and the `[patch.crates-io]` override is enabled; test commands are unchanged.
