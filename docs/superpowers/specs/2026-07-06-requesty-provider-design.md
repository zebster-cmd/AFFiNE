# Requesty API Gateway + Scenario Overrides for AFFiNE Copilot

- **Date:** 2026-07-06
- **Status:** Design — awaiting review
- **Scope:** Backend + native only (no frontend, no BYOK, no GraphQL)

## 1. Goal

Let a self-hosted AFFiNE operator route the AI copilot through the
[Requesty](https://requesty.ai) API gateway (an OpenAI-compatible LLM router),
and choose which Requesty-routed model backs each AI scenario (chat, image,
embedding, rerank, transcript) via server configuration.

Concretely, an operator configures:

```jsonc
{
  "copilot": {
    "enabled": true,
    // Configure Requesty as an EXPLICIT profile whose id is exactly "requesty",
    // so the "requesty/…" model prefixes below resolve (see note).
    "providers.profiles": [
      {
        "id": "requesty",
        "type": "requesty",
        "config": {
          "apiKey": "<REQUESTY_KEY>",
          "baseURL": "https://router.requesty.ai/v1",
        },
      },
    ],
    "scenarioOverrides": {
      "enabled": true,
      "models": {
        "chat": "requesty/sference/glm-5.2",
        "rerank": "requesty/nebius/qwen/qwen3-32b",
        "embedding": "requesty/nebius/Qwen/Qwen3-Embedding-8B",
        "transcript": "requesty/mistral/voxtral-mini-latest",
      },
    },
  },
}
```

> **CRITICAL — model prefix must match the provider profile id.** A
> `scenarioOverrides` value like `"requesty/sference/glm-5.2"` routes by splitting
> on the first `/`: the leading segment (`requesty`) must be the **id of a
> registered provider profile**, or the string is treated as one opaque model id
> and fails to resolve (`CopilotPromptInvalid`).
>
> Therefore configure Requesty via **`providers.profiles` with `"id": "requesty"`**
> (as above). Do **NOT** use the legacy `"providers.requesty": { … }` shape for
> this: that shape auto-generates the profile id `requesty-default` (the
> `${type}-default` convention in `toLegacyProfiles`), so `"requesty/…"` prefixes
> would NOT match — you would have to write `"requesty-default/…"` instead. The
> explicit-profile form is the supported configuration.
>
> **`image` is intentionally omitted** from the example above: it is blocked at
> the Requesty account/policy level (see spike findings) and, in AFFiNE, routes
> through a different (`/images/generations`) path than this chat gateway. It is
> deferred. **`transcript` additionally requires a code follow-up** (the transcript
> execution path hardcodes a Gemini provider preference that must be relaxed for
> the override to reach Requesty — see §7).

### Non-goals (this iteration)

- Per-workspace BYOK, GraphQL, or frontend settings UI.
- Exposing Requesty's full dynamic catalog. Only a **curated set** of models is
  registered; unlisted model IDs are rejected as they are today.
- The fine-grained text tiers from the original sketch (`coding`,
  `polish_and_summarize`, `quick_decision_making`, `quick_text_generation`,
  `complex_text_generation`). These are **not** distinguishable at the
  `featureKind` level and all resolve to the `chat` scenario model in v1.

## 2. Background: how the copilot resolves a model today

Established during context exploration (all paths under
`packages/backend/server/src/plugins/copilot/`):

- **Providers** are thin TypeScript classes (`providers/openai.ts`,
  `providers/anthropic/…`, etc.) over a **Rust native backend**. A provider's
  `getDriverSpec()` produces an `LlmBackendConfig { base_url, auth_token }`; the
  actual HTTP/streaming call happens in the `llm_adapter` / `llm_runtime` Rust
  crates.
- **`OpenAIProvider`** already parameterizes base URL and auth
  (`createNativeConfig`), and `oldApiStyle: true` selects the `openai_chat`
  backend kind (Chat Completions) instead of `openai_responses`.
- **Model resolution is registry-gated.** `provider-model-runtime.ts` calls
  `llmResolveModelRegistryVariant({ backendKind, modelId })`; if the model is not
  in the native registry it returns `undefined` and the request fails with
  `CopilotPromptInvalid`. The registry lives in the external `llm_adapter` crate
  (`v0.2.7`, published to crates.io) and is surfaced through
  `packages/backend/native/src/llm/core/model_registry.rs`
  (`default_model_registry_variants()`).
- **`backend_kind` is a closed enum**
  (`openai_chat | openai_responses | anthropic | cloudflare_workers_ai |
gemini_api | gemini_vertex | fal | anthropic_vertex` — see
  `native/src/llm/core/contracts/mod.rs`). There is no `requesty` kind and we do
  **not** add one; Requesty is OpenAI-Chat-compatible, so all Requesty variants
  use `backend_kind: "openai_chat"`.
- **Provider profiles** (`config.ts`, `provider-registry.ts`) let a provider be
  registered under a custom id with a model-id prefix (`requesty/<model>`); the
  prefix routes to the profile and is stripped before registry lookup.
- **Routing chokepoint:** `CopilotProviderFactory.resolveRoutes(cond, filter,
context)` (`providers/factory.ts`) is where `cond.modelId` and
  `context.featureKind` are both available for every output type.
- **Per-modality execution paths differ:**
  - chat / structured / embedding / image → provider `getDriverSpec()` +
    `prepareRoutes` / `prepareEmbeddingRoutes` / `prepareImageRoutes`.
  - rerank → `prepareRerankRoutes` (featureKind `rerank`); native
    `build_rerank_request` builds a **chat-completions** request (LLM-as-reranker,
    e.g. model `gpt-4.1-mini`). No dedicated `/rerank` endpoint.
  - transcript → a **separate subsystem** (`plugins/copilot/transcript/` —
    service, resolver, job, schema). Not a plain provider driver call.

## 3. Design

Three layers, server-side only.

### Layer 1 — `RequestyProvider` (transport)

A thin first-class provider type so Requesty and OpenAI-proper can be configured
independently and models get a clean `requesty/` prefix.

Files:

- `providers/types.ts` — add `Requesty = 'requesty'` to `CopilotProviderType`.
- `providers/requesty.ts` (new) — `class RequestyProvider extends OpenAIProvider`:
  - `readonly type = CopilotProviderType.Requesty`.
  - `resolveModelBackendKind()` → always `'openai_chat'` (Requesty = Chat
    Completions; ignore `oldApiStyle`).
  - `createNativeConfig()` → default `baseURL` to
    `https://router.requesty.ai/v1` when unset, else reuse `OpenAIProvider`.
  - Reuses `OpenAIConfig` (`{ apiKey, baseURL?, oldApiStyle? }`).
- `providers/provider-tokens.ts` — add `RequestyProvider` to `CopilotProviders`.
- `providers/provider-registry.ts` — add `CopilotProviderType.Requesty` to
  `LEGACY_PROVIDER_ORDER`.
- `config.ts`:
  - `CopilotProviderConfigMap[CopilotProviderType.Requesty] = OpenAIConfig`.
  - `RequestyConfigShape` zod (same shape as `OpenAIConfigShape`) + a
    discriminated-union entry in `CopilotProviderProfileShape`.
  - `providers.requesty` in `AppConfigSchema` + `defineModuleConfig` default
    `{ apiKey: '', baseURL: 'https://router.requesty.ai/v1' }`.

Models are referenced everywhere as `requesty/<requesty-model-id>`, e.g.
`requesty/sference/glm-5.2`.

### Layer 2 — Curated native registry variants (core work; spike-gated)

Register the five configured models as `openai_chat` registry variants with
hand-specified capabilities so registry resolution succeeds.

**Spike (must run first — determines the mechanism):** Is
`llm_adapter::core::ModelRegistryVariant` constructible from outside the crate
(public fields / constructor, or `serde::Deserialize` so it can be built from
JSON)?

- **If yes (preferred):** add a `requesty_variants()` function in
  `packages/backend/native/src/llm/core/model_registry.rs` and concatenate its
  output onto `default_model_registry_variants()` before
  `resolve_model_registry_variant` / `select_model_registry_variant`. **All
  changes stay in this repo.**
- **If no:** uncomment the `[patch.crates-io]` override in `Cargo.toml` /
  `.cargo/config.toml` and vendor/fork `llm_adapter` locally to add the variants.
  Heavier; touches a shared published dependency.

**Curated model set + capabilities:**

| Requesty model id                              | Scenario(s) | backend_kind | Capabilities (input → output)          | Risk   |
| ---------------------------------------------- | ----------- | ------------ | -------------------------------------- | ------ |
| `sference/glm-5.2`                             | chat        | openai_chat  | text → text, object, structured; tools | Low    |
| `nebius/Qwen/Qwen3-Embedding-8B`               | embedding   | openai_chat  | text → embedding                       | Low    |
| `nebius/qwen/qwen3-32b`                        | rerank      | openai_chat  | text → text (LLM reranker)             | Medium |
| `vertex/google/gemini-3.1-flash-image-preview` | image       | openai_chat  | text (+image) → image                  | High   |
| `mistral/voxtral-mini-latest`                  | transcript  | openai_chat  | audio → text                           | High   |

Exact capability flags (vision, tool use, reasoning, attachment kinds) are
finalized during implementation from Requesty's model metadata.

**Per-modality feasibility (the "all five in v1" reality):**

- **text, embedding** — clean OpenAI-compatible endpoints via Requesty
  (`/chat/completions`, `/embeddings`). Solid.
- **rerank** — Affine builds rerank as a chat-completions request, so a chat
  model behind Requesty works in principle. Validate the native rerank builder
  accepts the model and returns usable ordering.
- **image** — requires Requesty to proxy image _generation_ for the chosen model
  under a protocol Affine's image path emits (`openai_images` / `gemini`). If
  Requesty does not expose a compatible image endpoint for this model, this
  scenario is documented as unsupported until a compatible model/endpoint exists.
- **transcript** — requires (a) Requesty to expose an OpenAI-compatible audio
  transcription endpoint for the model, **and** (b) wiring the transcript
  subsystem (`plugins/copilot/transcript/`) to route through the Requesty
  provider/model. This is more than a registry variant and is the largest of the
  five.

Each modality has a **go/no-go validation task** in the spike. A modality that
cannot be validated against Requesty is shipped as a documented limitation with
a clear error, never as silently-broken config.

### Layer 3 — Scenario override (`copilot.scenarioOverrides`)

Config:

```ts
copilot.scenarioOverrides: {
  enabled: boolean;                          // default false
  models: Partial<Record<Scenario, string>>; // scenario -> "requesty/<model>"
}
// Scenario = 'chat' | 'image' | 'embedding' | 'rerank' | 'transcript'
```

Nested under the `copilot` module (Affine config is module-scoped;
`defineModuleConfig('copilot', …)`). This renames the original sketch's
top-level `ai.override_enabled` / `ai.scenarios`.

Behavior:

- A small `ScenarioModelResolver` maps `featureKind` → scenario:
  `chat|action → chat`, `image → image`, `embedding → embedding`,
  `rerank → rerank`, `transcript → transcript`.
- Injection at the single chokepoint `CopilotProviderFactory.resolveRoutes`:
  when `scenarioOverrides.enabled`, `resolve(cond, featureKind)` **unconditionally
  replaces** `cond.modelId` with the scenario model. (Transcript, which does not
  flow through `resolveRoutes`, consults the resolver at its own model-selection
  point in the transcript service.)
- **Precedence — FORCE-ALWAYS (as implemented):** when enabled and the scenario
  has a configured model, the override replaces whatever model the request/prompt/
  default supplied. (This resolves the design's original "force-always vs.
  user-wins" question in favor of force-always — the "user-wins" variant was
  inert because callers always pre-populate `cond.modelId` before routing.)
- **Config validation** helper `warnUnknownModels` exists but is **not yet wired**
  to a startup hook (deferred); a mis-set model currently surfaces as a
  `CopilotPromptInvalid` at request time rather than a load-time warning.

## 4. Error handling

- Missing key / baseURL → `RequestyProvider.configured()` is false → provider not
  registered; copilot feature simply unavailable for Requesty routes.
- Scenario model absent from registry → `CopilotPromptInvalid` at request time,
  pre-empted by the config-load warning.
- Requesty 4xx/5xx → existing `OpenAIProvider.handleError` →
  `CopilotProviderSideError`.

## 5. Testing

- **Native (Rust):** a `model_registry.rs` resolve test per curated variant
  (mirrors existing tests), asserting `backend_kind`/capabilities resolve.
- **Unit (TS):** `RequestyProvider` config defaults, forced `openai_chat`,
  `requesty/` prefix stripping; `ScenarioModelResolver` (featureKind→model,
  enabled/disabled, explicit-model-wins).
- **Integration/E2E:** one chat turn with `scenarioOverrides.enabled` routes to
  the Requesty `base_url` with `sference/glm-5.2`; one embedding call resolves
  the embedding scenario model. Rerank/image/transcript covered as their
  validation tasks land.

## 6. Build order

1. **Spike** — Layer 2 feasibility (in-repo augmentation vs. fork) **and**
   per-modality Requesty endpoint validation (text, embedding, rerank, image,
   transcript). Output: mechanism decision + go/no-go per modality.
2. **Layer 1** — `RequestyProvider` + config wiring.
3. **Layer 2** — register text + embedding variants (validated-safe first).
4. **Layer 3** — `copilot.scenarioOverrides` config + `ScenarioModelResolver` +
   `resolveRoutes` injection + config-load validation.
5. **Remaining modalities** — rerank, image, then transcript (incl. transcript
   service wiring), each landing behind its validation result.

## 7. Open questions / risks / known follow-ups

- **Spike outcome for Layer 2** — RESOLVED: `ModelRegistryVariant` derives
  `Deserialize` with public fields, so in-repo append works (Mechanism A); no
  `llm_adapter` fork needed.
- **Override precedence** — RESOLVED to **force-always** (see §3).
- **Image** — deferred: blocked at the Requesty account/policy level, and routes
  through AFFiNE's `/images/generations` path rather than this chat gateway. Needs
  Requesty dashboard enablement + a chat-image-vs-images-endpoint wiring decision.
- **FINDING B — transcript Gemini preference (code): PARTIALLY ADDRESSED.** The
  transcript path (`transcript/service.ts` → `transcriptTask`) hardcoded
  `prepareStructuredRoutes(..., { prefer: CopilotProviderType.Gemini })`, whose
  preferred-provider filter excluded every non-Gemini provider — so a `transcript`
  override could never route. **Fixed:** `prefer` is now `undefined` when a
  transcript scenario override is active (default transcription path unchanged).
- **FINDING B2 — transcript model shape mismatch (deeper, NOT fixed):** AFFiNE
  transcription is **not** dedicated STT. `transcriptTask` uses the
  `'Transcript audio structured'` prompt, sends audio as **attachments** to a
  multimodal model, and calls `prepareStructuredRoutes` with a `responseContract`
  (structured JSON) — it needs an **audio-input + structured-output multimodal**
  model (Gemini-class). The Task 7 curated variant `mistral/voxtral-mini-latest`
  is dedicated STT (audio → plain `{text}`, `output: ["text"]`), so the structured
  route rejects it even with `prefer` relaxed. To transcribe via Requesty: point
  the `transcript` override at a Requesty **Gemini-class multimodal chat model**
  (audio-capable, structured output), add a curated variant with
  `input: ["text","audio"]` + `output: ["structured","text"]` + audio attachment
  capability, and **live-verify Requesty passes audio attachments through
  `/chat/completions`** for that model (the spike only validated the STT
  `/audio/transcriptions` path, which this pipeline does not use). Using `voxtral`
  via `/audio/transcriptions` would instead require a new dedicated-STT execution
  path — a larger change.
- **KNOWN FOLLOW-UP — `warnUnknownModels` wiring:** helper exists, not wired to a
  startup hook; no registry-enumeration API makes a clean known-set awkward.
  Mis-set models fail loudly at request time, so low impact.
