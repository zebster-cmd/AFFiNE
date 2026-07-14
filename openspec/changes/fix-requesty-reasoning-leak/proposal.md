## Why

Models served through the Requesty router (notably GLM 5.2 / `sference/glm-5.2`) emit their chain-of-thought **inline** as `<think>…</think>` tags inside the normal content stream rather than in a separate reasoning field. The copilot layer has no mechanism to detect or separate inline reasoning, so the thinking text is treated as ordinary content — accumulated verbatim and baked into generated HTML code artifacts, where it is plainly visible in the preview. A second, latent defect means even _correctly_ separated reasoning (e.g. Claude) is folded back into the content string that the code-artifact tool consumes. The result is leaked reasoning in user-facing output.

## What Changes

- Inline `<think>…</think>` segments in the assistant content stream are detected in the TypeScript adapter layer and re-routed onto the existing **reasoning** channel (`reasoning-delta` / `{ type: 'reasoning' }`) instead of being emitted as content, for both the `streamText` and `streamObject` paths.
- The non-streaming text/tool path stops folding reasoning into returned content: `extractTextResponse` drops `type === 'reasoning'` parts, and `adapter.text()` skips reasoning-delta chunks. Tool-driven prompts (e.g. Code Artifact) receive content only.
- As a result, `code_artifact` output no longer contains `<think>` tags or reasoning text, regardless of whether the model separates reasoning natively or emits it inline.
- (Optional, evaluated in design) Tag the Requesty GLM model variant with a reasoning behavior flag so the request asks for separated reasoning where the provider supports it — but inline `<think>` stripping remains as an always-on safety net.

## Capabilities

### New Capabilities

- `copilot-reasoning-separation`: Reasoning/"thinking" output — whether delivered natively as a separate field or inline as `<think>…</think>` tags — is isolated onto the reasoning channel and excluded from assistant content and from tool/artifact text.

### Modified Capabilities

<!-- None: there are no existing specs under openspec/specs/. -->

## Impact

- **Code (backend copilot layer only):**
  - `packages/backend/server/src/plugins/copilot/runtime/tool/native-adapter.ts` — `streamText` (~213-238), `streamObject` (~343-354), and `text()` accumulation (~164-174).
  - `packages/backend/server/src/plugins/copilot/providers/utils.ts` — `TextStreamParser` `'text-delta'` handling (~145-158); reference behavior in `StreamObjectParser.mergeContent` (~365-372).
  - `packages/backend/server/src/plugins/copilot/runtime/native-execution-engine.ts` — `extractTextResponse` (59-64).
  - (Optional) `packages/backend/native/src/llm/core/model_registry.rs` — Requesty GLM variant behavior flag (requires native rebuild).
- **No changes** to the external Rust `affine_doc_loader` or `llm_adapter` crates (the SSE decode is compiled and out of scope).
- **Tests:** server-side ava suite under `packages/backend/server/src/__tests__/copilot/` (CI Node 22).
- **Behavior:** user-facing output (chat + artifacts) no longer leaks reasoning; reasoning remains available on its own channel for display as callouts.
