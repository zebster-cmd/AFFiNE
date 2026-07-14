## 1. Inline reasoning splitter (TDD)

- [x] 1.1 Add a failing unit test: a helper that, given a sequence of content chunks containing `<think>…</think>`, yields separated `{ content, reasoning }` streams — assert reasoning routed out, content clean, no tag markers left
- [x] 1.2 Add a failing test for tags split across chunk boundaries (feed the same input split at every offset; content + reasoning must reassemble exactly)
- [x] 1.3 Add a failing test for an unterminated `<think>` (flush open buffer to reasoning on stream end, never to content)
- [x] 1.4 Add a failing test that content with no `<think>` tags passes through unchanged
- [x] 1.5 Implement the stateful `<think>` splitter (insideThink flag + partial-boundary carry buffer) to make 1.1–1.4 pass

## 2. Wire the splitter into the adapter paths

- [x] 2.1 Apply the splitter in `native-adapter.ts` `streamText` (~213-238): inside-think text → `reasoning-delta`, outside → `text-delta`
- [x] 2.2 Apply the splitter in `native-adapter.ts` `streamObject` (~343-354): inside-think → `{type:'reasoning'}`, outside → `{type:'text-delta'}`
- [x] 2.3 Add a test proving a GLM-style inline `<think>` stream produces reasoning on its channel and clean content on both stream paths

## 3. Purge reasoning from the non-streaming text/tool path

- [x] 3.1 Add a failing test: `extractTextResponse` (`native-execution-engine.ts:59-64`) drops `type === 'reasoning'` parts, keeps only `text`
- [x] 3.2 Change `extractTextResponse` filter to `type === 'text'` only
- [x] 3.3 Add a failing test: `adapter.text()` (`native-adapter.ts:164-174`) skips reasoning-delta chunks
- [x] 3.4 Update `adapter.text()` accumulation to skip reasoning-delta chunks

## 4. End-to-end artifact assertion

- [x] 4.1 Add a test that a `code_artifact` prompt over a stream containing inline `<think>` tags returns HTML with no `<think>`/`</think>` markers and no reasoning text
- [x] 4.2 Add a test for the same over a natively-separated-reasoning response (reasoning parts present) → artifact still content-only

## 5. Optional: Requesty GLM reasoning flag

- [x] 5.1 Evaluate adding a `reasoning_supported`/behavior flag to the Requesty GLM variant in `model_registry.rs` — **DEFERRED**. The inline `<think>` splitter already fully fixes the symptom and is provider-agnostic. Adding the flag requires a native (Rust) rebuild and depends on whether Requesty forwards a reasoning-separation param for GLM and whether GLM honors it — an optimization that needs testing against the live Requesty API, not required for the fix. The splitter stays as the always-on safety net regardless.
- [x] 5.2 N/A — flag deferred (see 5.1); no native rebuild performed.

## 6. Verify

- [~] 6.1 Copilot ava suite: **cannot run locally** — ava fails to bootstrap its prelude under local Node 24 (`ERR_MODULE_NOT_FOUND` resolving `src/prelude.ts`), the exact "runs in CI on Node 22, not locally" constraint noted in design. Verified equivalent behavior via standalone `tsx` execution: **58 splitter assertions + 13 integration assertions (streamText/streamObject/text/extractTextResponse/code_artifact) all green**, plus a clean `tsc --noEmit` on all changed files and the spec. The ava specs themselves run in CI on Node 22.
- [x] 6.2 Manual GLM 5.2-via-Requesty artifact check — confirmed on the live deployment: HTML artifact preview shows no thinking blocks.
