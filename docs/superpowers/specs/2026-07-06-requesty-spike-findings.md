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

## 2. Per-modality Requesty endpoint validation → **PENDING (needs a Requesty API key).**

Not yet run — requires a live `REQUESTY_KEY`. When available, run Task 0 Step 4
probes against `https://router.requesty.ai/v1` and record served/not-served for:

- [ ] chat — `POST /chat/completions` (`sference/glm-5.2`)
- [ ] embedding — `POST /embeddings` (`nebius/Qwen/Qwen3-Embedding-8B`)
- [ ] rerank — chat probe with `nebius/qwen/qwen3-32b` (LLM-based; no `/rerank`)
- [ ] image — `POST /images/generations` (`vertex/google/gemini-3.1-flash-image-preview`)
- [ ] transcript — `POST /audio/transcriptions` (`mistral/voxtral-mini-latest`)

Text (Task 2) and embedding (Task 2) are low-risk regardless. Image/rerank/
transcript variant tasks (6/5/7) are gated on their probe result.

## 3. Environment note

Repo has toolchains (node 24, yarn 4.13, cargo 1.96) but **root `node_modules`
is not installed** and the native `.node` is not built. Executing any task's
tests requires a full `yarn install` (large) + native build first.
