## Context

The copilot streaming pipeline turns provider SSE into a union of stream parts. Reasoning has a first-class channel already: the native `llm_adapter` emits `LlmToolLoopStreamEvent`s (`text_delta` / `reasoning_delta`, `native.ts:708-712`), which `native-adapter.ts` maps to `text-delta` / `reasoning-delta` (streamText ~213-238) and `{type:'text-delta'}` / `{type:'reasoning'}` (streamObject ~343-354). `TextStreamParser` styles reasoning as callouts (`utils.ts:275-277`), and `StreamObjectParser.mergeContent` already keeps only `text-delta` for the UI object path (`utils.ts:365-372`).

This machinery only works when the provider delivers reasoning as a **separate field**. GLM via Requesty (`RequestyProvider extends OpenAIProvider`, `resolveModelBackendKind() = 'openai_chat'`) instead embeds reasoning inline as `<think>…</think>` inside `content`, so it arrives as `text_delta` and is treated as content. A repo-wide search for `<think`, `think>`, `reasoning_content` returns zero matches — nothing separates inline reasoning today. Separately, the non-streaming text path deliberately folds reasoning into content: `extractTextResponse` filters `type === 'text' || type === 'reasoning'` (`native-execution-engine.ts:59-64`) and `adapter.text()` concatenates every chunk including reasoning (`native-adapter.ts:164-174`). Both feed `code-artifact.ts:37-55`, which consumes the raw string.

Constraint: the SSE decode itself lives in the external compiled Rust `llm_adapter` crate and is out of reach. The fix must live in the in-repo TypeScript adapter/runtime layer.

## Goals / Non-Goals

**Goals:**

- Strip inline `<think>…</think>` from the content stream and re-route it to the reasoning channel, in both streamText and streamObject paths, robust to tags split across chunks.
- Ensure non-streaming tool/artifact text (`extractTextResponse`, `adapter.text()`) contains content only, never reasoning.
- Keep reasoning available on the reasoning channel for UI display.

**Non-Goals:**

- Modifying the external Rust `affine_doc_loader` / `llm_adapter` crates.
- Changing how natively-separated reasoning (Anthropic/Gemini/OpenAI) is produced.
- Broad prompt-output sanitization beyond reasoning isolation.

## Decisions

**Decision 1 — Split inline `<think>` in the TS adapter layer, not at the SSE decode.**
The SSE decode is compiled and unmodifiable. Implement a small stateful tag-splitter applied to `text_delta` text as it is turned into stream parts in `native-adapter.ts`. It maintains an `insideThink` flag and a small carry buffer for a possibly-partial boundary tag, emitting text outside think as `text-delta`/`{type:'text-delta'}` and text inside think as `reasoning-delta`/`{type:'reasoning'}`.

- _Alternative considered:_ strip in `TextStreamParser.parse` `'text-delta'` case (`utils.ts:145-158`). Rejected as the single point because the parser is content-formatting-oriented and the object path (`StreamObjectParser`) would still need the split; doing it once at the adapter boundary covers both `streamText` and `streamObject`.
- _Alternative considered:_ strip only in `code-artifact.ts`. Rejected — a band-aid that leaves raw `<think>` leaking into chat and other tools.

**Decision 2 — Stateful splitter tolerant of chunk boundaries.**
Tags can split across chunks (`<th|ink>`, or body across many deltas). The splitter buffers a trailing partial that could be the start of `<think>`/`</think>` and only commits text once it is known not to be a tag boundary. This satisfies the "split across chunks" scenario.

**Decision 3 — Fix the non-streaming text path independently.**
Even with Decision 1, `adapter.text()` accumulates reasoning-delta chunks and `extractTextResponse` keeps reasoning parts. Change `extractTextResponse` to filter `type === 'text'` only, and make `text()` skip reasoning-delta chunks. Both are required; Decision 1 alone does not stop the artifact leak for models that separate reasoning natively.

**Decision 4 — Requesty GLM reasoning behavior flag is optional and secondary.**
Adding a `reasoning_supported` behavior flag to the GLM variant in `model_registry.rs` could make Requesty return separated reasoning where supported, but requires a native rebuild and depends on provider behavior. The `<think>` splitter must exist regardless as the safety net, so the flag is deferred/optional and evaluated after the splitter lands.

## Risks / Trade-offs

- **False positives — legitimate `<think>` in user content (e.g. a doc about HTML/XML).** → Scope the splitter to the reasoning-prone path and only treat `<think>` at the start of a reasoning segment; keep it conservative (exact tag match, not arbitrary angle-bracket content). Covered by the "content without think tags is unchanged" scenario.
- **Chunk-boundary bugs dropping or duplicating characters.** → Unit tests that feed the same content split at every offset and assert content + reasoning reassemble exactly.
- **Nested or malformed tags (`<think>` with no close).** → On stream end, flush any open think buffer to the reasoning channel (never to content).
- **Other tools relying on reasoning-in-content.** → Grep confirms none do; `mergeContent` already excludes reasoning, so aligning `text()`/`extractTextResponse` matches existing intent.

## Migration Plan

- Backend-only, no schema/data migration. Ships via the existing CI image build → redeploy loop used for prior copilot changes.
- If Decision 4's model-registry flag is included, it requires a native rebuild (same as prior tool-wiring changes).
- Rollback: revert the adapter/runtime changes; no persisted state is affected.

## Resolved Decisions

- **Splitter scope:** applied **universally** but conservatively — it reacts only to literal `<think>`/`</think>` tags, so it is a no-op for providers that separate reasoning natively (Claude/Gemini/OpenAI). No per-provider gating; it serves as a general safety net.
- **Tag set:** handle **`<think>` only** (the confirmed GLM convention). Other conventions (`<thinking>`, `<reasoning>`) are deliberately not stripped, to avoid eating legitimate content that references those tags; expand only if another model is shown to leak.
