# Requesty Provider — SDD Progress Ledger

Plan: docs/superpowers/plans/2026-07-06-requesty-provider.md
Branch: requesty-provider-spec

- Task 0: PARTIAL — mechanism spike complete (Mechanism A / in-repo append confirmed against llm_adapter 0.2.7). Endpoint validation (Step 4) PENDING: needs REQUESTY_KEY.
- Task 1: not started
- Task 2: not started
- Task 3: not started
- Task 4: not started
- Task 5: not started (gated on Task 0 rerank probe)
- Task 6: not started (gated on Task 0 image probe)
- Task 7: not started (gated on Task 0 transcript probe)
- Task 8: not started (needs REQUESTY_KEY for smoke)

BLOCKERS:

- REQUESTY_KEY not set (blocks Task 0 Step 4, Task 8 smoke).
- root node_modules not installed; native .node not built (blocks running any task's tests).

## Update (endpoint validation + scope)

- Requesty exposes OpenAI-compatible endpoints for ALL 5 modalities (chat, embeddings, audio/transcriptions, images/generations). /models lists chat-only but other endpoints work. => single-gateway all-five retained; NO multi-gateway needed.
- Model IDs: chat sference/glm-5.2 (catalog-confirmed), rerank nebius/qwen/qwen3-32b (confirmed), image google/gemini-3.1-flash-image-preview (confirmed), embedding nebius/Qwen/Qwen3-Embedding-8B (endpoint exists, live-unverified), transcript mistral/voxtral-mini-latest (endpoint exists, live-unverified).
- BLOCKER: provided Requesty key returns 403 invalid -> no live inference/smoke.
- BLOCKER: test harness needs Node 22.23 + affine CLI wrapper; running ava on Node 24 here fails (prelude path). deps installed, native built.
