# Requesty Spike Findings

- **Date:** 2026-07-06
- **Plan:** `docs/superpowers/plans/2026-07-06-requesty-provider.md` (Task 0)

## 1. Registry augmentation mechanism → **Mechanism A (in-repo append). CONFIRMED.**

Inspected `llm_adapter 0.2.7` source
(`~/.cargo/registry/src/index.crates.io-*/llm_adapter-0.2.7/src/core/model_registry.rs`):

- `pub struct ModelRegistryVariant` derives `Deserialize, Serialize`
  (`#[serde(rename_all = "camelCase")]`) and **all fields are `pub`**:
  `backend_kind, canonical_key, raw_model_id, display_name?, aliases,
legacy_aliases?, capabilities, protocol?, request_layer?, route_overrides?,
behavior_flags?`. → constructible via `serde_json::from_value(json!({…}))`
  using the camelCase keys already shown in the plan.
- `pub fn default_model_registry_variants() -> Vec<ModelRegistryVariant>` —
  returns an **owned Vec**; safe to `.to_vec()` / `.extend()`.
- `pub fn resolve_model_registry_variant<'a>(variants: &'a [ModelRegistryVariant],
backend_kind: Option<&str>, model_id: &str) -> Result<Option<(&'a ModelRegistryVariant, &'static str)>, String>`
  and `select_model_registry_variant<'a>(…)` — both `pub`, take a slice.

**Conclusion:** append curated variants inside
`packages/backend/native/src/llm/core/model_registry.rs` by extending
`default_model_registry_variants().to_vec()` and passing the merged slice to
the existing resolve/select calls. **No fork of `llm_adapter` and no
`[patch.crates-io]` override required.** Plan Tasks 2/5/6/7 code is valid
as written against `llm_adapter 0.2.7`.

## 2. Per-modality Requesty endpoint validation → **DONE via public catalog. Major scope impact.**

`GET https://router.requesty.ai/v1/models` is **public** (returns 200 with no /
bogus token — so a 200 there proves nothing about a key). It lists **562
models, every one `api: "chat"`**. Requesty's router is **chat-completions-only**.

Catalog check of the configured models:

| Scenario / configured model                     | Catalog status                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| chat — `sference/glm-5.2`                       | ✅ exists (chat) — also `zai/glm-5.2`, `tensorx/glm-5.2`                                                                  |
| rerank — `nebius/qwen/qwen3-32b`                | ✅ exists (chat) — LLM-based rerank viable                                                                                |
| image — `google/gemini-3.1-flash-image-preview` | ⚠️ exists but **chat api** — image via `/chat/completions`, NOT the `/images/generations` path Affine's image route emits |
| embedding — `nebius/Qwen/Qwen3-Embedding-8B`    | ❌ not in catalog — no embedding-api models at all                                                                        |
| transcript — `mistral/voxtral-mini-latest`      | ❌ not in catalog — no audio/transcription models                                                                         |

### 2a. CORRECTION — `/models` lists chat models only; Requesty serves all modalities.

Requesty's API docs (`docs.requesty.ai/api-reference/inference-apis`) confirm
**OpenAI-compatible endpoints for every modality** under
`https://router.requesty.ai/v1`:

- `POST /chat/completions` — chat (also image/rerank via chat)
- `POST /embeddings` — embeddings
- `POST /audio/transcriptions` — speech-to-text
- `POST /audio/speech` — TTS
- `POST /images/generations` — image generation
- `GET /models` — **enumerates chat models only**; the `?api=` filter is
  ignored (returns the same 562 chat entries regardless). Embedding/audio/image
  models are not listed but their endpoints work.

**Consequences for the plan (single-gateway, all five retained):**

- **No multi-gateway needed.** One Requesty provider covers all five modalities.
- **chat / rerank** → `/chat/completions` (`sference/glm-5.2`,
  `nebius/qwen/qwen3-32b`). Confirmed present in catalog.
- **embedding** → `/embeddings` (`nebius/Qwen/Qwen3-Embedding-8B`). Not in the
  chat listing; routes through Affine's embedding driver. Needs live validation.
- **image** → `/images/generations` (`google/gemini-3.1-flash-image-preview`,
  present in catalog). Routes through Affine's image driver (`openai_images`).
- **transcript** → `/audio/transcriptions` (`mistral/voxtral-mini-latest`).
  Routes through Affine's transcript subsystem (Task 7 wiring). Needs live
  validation.
- Remaining unknown per modality is **live behavior**, blocked only by the
  invalid key (below) — not by model availability.

## 2b. Live validation (valid key) → **4 of 5 modalities confirmed.**

(A first key was invalid — 403 invalid token. A second, working key validated
the endpoints below. Keys handled via env var only; never written or committed.
Recommend rotating any key pasted into chat.)

| Modality         | Endpoint                | Model                                   | Result                               |
| ---------------- | ----------------------- | --------------------------------------- | ------------------------------------ |
| chat             | `/chat/completions`     | `sference/glm-5.2`                      | ✅ 200 (routed to `zai-org/GLM-5.2`) |
| rerank           | `/chat/completions`     | `nebius/qwen/qwen3-32b`                 | ✅ 200 (LLM-based rerank viable)     |
| embedding        | `/embeddings`           | `nebius/Qwen/Qwen3-Embedding-8B`        | ✅ 200, 4096 dims                    |
| transcript       | `/audio/transcriptions` | `mistral/voxtral-mini-latest`           | ✅ 200 (endpoint functional)         |
| image            | `/images/generations`   | `google/gemini-3.1-flash-image-preview` | ❌ 404 "model not supported"         |
| image (via chat) | `/chat/completions`     | same                                    | ❌ 403 "Provider blocked by policy"  |
| image (control)  | `/images/generations`   | `openai/gpt-image-1`, `openai/dall-e-3` | ❌ 404 "not supported"               |

**Image conclusion:** not serviceable on this Requesty account as configured —
image providers appear policy-gated (dashboard toggle) and the OpenAI images
endpoint isn't matched. **v1 = chat, rerank, embedding, transcript (4/5).**
Image deferred pending Requesty dashboard enablement + a decision on chat-image
vs `/images/generations` wiring.

## 3. Environment note

Repo has toolchains (node 24, yarn 4.13, cargo 1.96) but **root `node_modules`
is not installed** and the native `.node` is not built. Executing any task's
tests requires a full `yarn install` (large) + native build first.
