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

## Update (LIVE validation with working key)

- Working key confirmed. Validated live: chat ✅, rerank(chat) ✅, embedding ✅ (4096d), transcript ✅ (endpoint 200).
- image ❌ blocked: gemini image via chat = 403 "Provider blocked by policy"; /images/generations 404 for gemini + openai image models. => image deferred pending Requesty dashboard enablement.
- v1 scope now: chat, rerank, embedding, transcript (Tasks 1-5,7). Image (Task 6) deferred.
- Still open: test EXECUTION needs Node 22.23 harness (this session Node 24 fails ava prelude resolution). Code can be written; local test run unresolved.

## Task 1: COMPLETE (commit 2ba69698..d3886f76bc, review clean)

- Spec ✅, quality Approved. Deviations (openai.ts type widening, provider-middleware Requesty entry) verified necessary+correct.
- MINOR findings (for final review triage): (a) config.ts RequestyConfigShape inherits oldApiStyle which RequestyProvider ignores (dead knob) — consider doc comment; (b) provider-middleware Requesty entry appended rather than near OpenAI (cosmetic).

## Task 2: COMPLETE (commit d3886f76bc..1ce2f94238, review clean)

- Spec ✅, quality Approved. cargo test model_registry: 9 passed (7 pre-existing + 2 new). Native rebuilt.
- Reviewer ⚠️ (tests use helper, not merged napi path) RESOLVED by controller: the 7 pre-existing tests exercise the napi wrappers which now route through all_registry_variants() and still pass -> merge doesn't shadow/break defaults.
- MINOR (final-review triage): model_registry.rs:46 redundant `.to_vec()` (from brief verbatim).

## Task 3: COMPLETE (commits 1ce2f94238..e9334836, review clean after 1 fix)

- Spec ✅, DI registration ✅ (added to COPILOT_PROVIDER_PROVIDERS in module-providers.ts, same CopilotKernelModule as the factory). Injection at top of resolveRoutes using context.featureKind. tsc clean on touched files.
- CRITICAL found+fixed: 4th ctor param broke 3 manual `new CopilotProviderFactory(...)` sites in provider-native.spec.ts -> passed a disabled ScenarioModelResolver 4th arg (commit e9334836). tsc: 0 TS2554, provider-native.spec.ts clean. (ava deferred to CI.)

## Task 4: COMPLETE (commit e9334836..ce03b5520490, review clean)

- Spec ✅, quality Approved, no findings. warnUnknownModels + test. tsc clean on touched files. (ava deferred to CI.)

## ALL v1 TASKS (1-4) COMPLETE. Next: final whole-branch review over 2ba69698..ce03b552.

## FINAL WHOLE-BRANCH REVIEW: NOT READY (opus)

- CRITICAL: scenarioOverrides is INERT. resolve() only injects when cond.modelId is absent, but every caller (turn-orchestrator, action-runtime-bridge, task-policy embedding/rerank) pre-populates modelId from prompt/session/default BEFORE resolveRoutes. So override never fires in production. Unit tests pass only via artificial empty cond. => plan-mandated semantic ("user-wins" via ??=) doesn't work; needs design decision (force-always vs distinguish user-explicit-vs-default vs inject-earlier).
- IMPORTANT: embedding variant unreachable e2e (task-policy returns hardcoded DEFAULT_EMBEDDING_MODEL; override never fires). Ties to CRITICAL.
- IMPORTANT: warnUnknownModels never invoked (Task 4 scoped method-only, but design/commit claim load-time warning). Wire into lifecycle onConfigInit/onConfigChanged, or downgrade claim.
- Transport layer (RequestyProvider+config+native chat variant+registration) = SOUND. Security clean. 3 known Minors = all DEFER.
- ADJUDICATION NEEDED from user before further fix (plan-level design flaw).

## FINAL REVIEW RESOLUTION

- CRITICAL (scenarioOverrides inert): FIXED via force-always (commit 947331b6). Controller-verified: early-return removed; factory calls resolve() at top of resolveRoutes; enabled+mapped scenario now replaces cond.modelId unconditionally -> feature fires for chat/structured/image/embedding/rerank. tsc clean; test inverted.
- IMPORTANT #2 (embedding unreachable): FIXED as consequence of force-always (embedding scenario override now replaces hardcoded DEFAULT_EMBEDDING_MODEL at resolveRoutes).
- IMPORTANT #3 (warnUnknownModels unwired + commit overclaim): ACCEPTED FOLLOW-UP. Rationale: plan scoped Task 4 to method+test only; no native registry-enumeration API for a clean known-set; misconfig fails loudly at request time (CopilotPromptInvalid), no silent failure. Wiring deferred.
- 3 Minors: all DEFER (oldApiStyle inert knob; redundant .to_vec(); middleware ordering).

## BRANCH STATE: v1 transport + chat/embedding + force-always scenario routing COMPLETE on requesty-provider-spec. Deferred: rerank/transcript native variants (T5/T7), image (T6, Requesty policy-blocked), warnUnknownModels wiring, CI test execution (Node 22.23), key rotation.

## Task 5 (rerank variant): implemented, commit 947331b6..63916da0. cargo test model_registry: 10 passed (RED-then-GREEN). Native rebuilt. Pending quick review.

## Task 5 (rerank): COMPLETE (commit 947331b6..63916da0, review clean). Spec ✅ Quality Approved (1 cosmetic minor). cargo 10 passed.

## Task 7 (transcript): implemented, commit 63916da0..81d183c6. Native cargo 11 passed (RED-GREEN). tsc clean. DI verified (CopilotFeatureModule imports CopilotKernelModule). CONCERN: transcript prepareStructuredRoutes hardcodes prefer:Gemini -> may block requesty/ override from routing; needs review trace + CI/live verify.

## Task 7: COMPLETE for its scope (commit 63916da0..81d183c6). Spec ✅ Quality Approved, DI verified. cargo 11 passed.

## BUT review surfaced TWO execution-layer routing gaps (follow-up work, out of Task 7 file scope):

- FINDING A (FEATURE-WIDE, config/spec bug): `requesty/`-prefixed scenario models only parse if a provider PROFILE with id exactly "requesty" exists. The documented legacy config `copilot.providers.requesty` yields profile id "requesty-default" (via toLegacyProfiles `${type}-default`), so parseModelPrefix fails -> the whole string is treated as a bare modelId -> native resolve of "requesty/sference/glm-5.2" fails (canonical key is "sference/glm-5.2"). => scenarioOverrides won't route to Requesty under documented config. FIX: configure via copilot.providers.profiles=[{id:"requesty",type:"requesty",config}] (then works), or prefix with "requesty-default/". Update spec examples.
- FINDING B (transcript-specific, code): transcriptTask hardcodes prefer: CopilotProviderType.Gemini in prepareStructuredRoutes -> isAllowed() preferred-filter excludes Requesty entirely -> transcript override => hard failure "No native structured provider route prepared". FIX: make prefer conditional/removed when a transcript override is active.

## FIX A: DONE (commit cfc2b2c4ed) — spec corrected to explicit-profile config (id:"requesty") so requesty/ prefixes resolve; documented legacy-shape pitfall; force-always precedence; Finding B + warnUnknownModels recorded as known follow-ups in §7.

## Finding B (transcript prefer:Gemini): NOT fixed (user scoped to A). Remains documented follow-up.

---

# Copilot Database/Kanban Tools — SDD Progress (plan 2026-07-11-copilot-database-tools.md)

Base commit: 5ad427cbed. Branch: requesty-provider-spec. Node 24 => ava runs in CI only; implementers verify via tsc.

- Task 1 (types + fixture): COMPLETE (commit 5ad427cbed..ed5dcf8e2e). `database-types.ts` (PropertyType/ColumnJSON/RowJSON/ViewJSON/BoardJSON + 8-op `DatabaseOp` union + `DatabaseOpSchema` zod), `fixtures/database-doc.ts` (`buildBoardDoc`, fixed ids), `database-fixture.spec.ts` (verbatim from brief). tsc clean on all 3 files (64 pre-existing unrelated lines elsewhere). Runtime-verified via `tsx` smoke run (ava can't execute on Node 24 here) — matches all spec assertions. ava deferred to CI (Node 22.23).
- Task 1: COMPLETE (commits 5ad427cbed..2d24635b0b, review clean after op-shape fix). Spec ✅ Quality Approved. MINOR (final-review triage): fixtures/database-doc.ts sets explicit `color: undefined` vs conditional spread elsewhere (cosmetic).
- Task 2 (value codec): in progress (base 2d24635b0b)
- Task 2 (codec): implemented (89fff188c5), review = Changes needed (checkbox Boolean('false')===true bug). Fix in flight.
  **_ WRITER-TASK CAVEAT (Tasks 4/5/7 must heed): `prop:columns` is a Y.Array of PLAIN JS objects. encodeCell auto-creates select options by MUTATING column.data.options in place, but Yjs incremental/state-vector sync does NOT capture nested-plain-object mutations. The writer MUST re-persist the mutated column back into the Y.Array (delete+insert the element, or replace prop:columns) after encodeCell, or auto-created options silently fail to propagate to collaborators/persist. Same class as the Y.Text-integration gotcha. Add a test that a writer op which auto-creates an option survives an encodeStateAsUpdate delta round-trip. _**
- Task 2: COMPLETE (commits 2d24635b0b..1fe7f49c7d, review clean after checkbox-string fix). Spec ✅ Quality Approved. Codec: encodeCell/decodeCell/isReadOnlyType, select/multi-select auto-create, CodecError for read-only. MINOR (final triage): number/date use bare Number() (NaN not guarded) — accepted permissive.
- Task 3 (DatabaseReader): in progress (base 1fe7f49c7d)
- Task 3 (DatabaseReader): implemented (16e7a2b115), review = Changes needed (CRITICAL: kanban groupBy read as flat string but real BlockSuite stores it as object {type:'groupBy',columnId,name}). Fix in flight (fixture+reader+tests+design doc).
  **_ TASK 6 CAVEAT (kanban writer): when writing a kanban view, `groupBy` MUST be the object {type:'groupBy', columnId, name}, NOT a flat string. groupProperties[] = {key, manuallyCardSort:[]} per blocksuite data-view core/common/types.ts. manuallyCardSort = card order within group. Card membership = the row's group-column cell value. _**
- Task 3: COMPLETE (commits 1fe7f49c7d..a86c068d3a, review clean after CRITICAL groupBy-object fix). Spec ✅ Quality Approved. readBoardFromBinary/listBoardsFromBinary; kanban groupBy now the real nested object. MINOR (final triage, DEFER): resolveKanbanGroups still String(rawValue)+decode for bucket key — lossy only for checkbox group-by (unrealistic; kanban group-by is select).
- Task 4 (DatabaseWriter foundation + column ops): in progress (base a86c068d3a)
- Task 4: COMPLETE (commits a86c068d3a..cf99fb28ce, review clean, no Critical/Important). DatabaseWriter foundation (applyToBinary state-vector delta + applyOps push/emit mirroring DocWriter) + add/update/delete_column (Y.Array element-replace handles the plain-object caveat; delete purges cells). Registered in DocStorageModule DI. MINORs (final triage): dup block-validation vs reader; delete_column doesn't cascade into kanban view groupBy (-> Task 6 note).
  **_ TASK 6 CAVEAT: delete_column should also clean a kanban view's groupBy/groupProperties if it referenced the deleted column (left dangling by Task 4, out of its scope). _**
- Task 5 (row + cell ops): in progress (base cf99fb28ce)
- Task 5: COMPLETE (commits cf99fb28ce..f035fbffb0, review clean after writeCell row-existence fix). add_row/update_cell/delete_row; writeCell rejects unknown rowId, re-persists column only for select/multi-select. MINOR (final triage): plain-Error vs CodecError typing on read-only reject.
  NOTE: I forgot to pre-extract task-5-brief (reviewer saw a stale one); implementation was correct anyway (self-contained dispatch). Fixed: briefs now pre-extracted.
- Task 6 (kanban move_card + add_view): in progress (base f035fbffb0)
- Task 6: COMPLETE (commits f035fbffb0..701b835b7d, review clean, no Critical/Important). move_card + add_view; nested groupBy object; views Y.Array element-replace; ensureGroupColumn default Status select; group key = option id (consistent w/ reader). MINORs (final triage): (a) groupBy.name stores column display name not the matcher name 'select' (nil impact, reader falls back; matches fixture precedent); (b) ensureGroupColumn silently defaults when given a non-select columnId.
- Now fixing stale test: database-writer-columns.spec.ts asserts add_row throws 'not implemented' (false since Task 5). All 8 ops now implemented -> default only hit by unknown op.
- Task 7 (createBoard): in progress (base 966d2d12b4)
- Task 7: COMPLETE (commits 966d2d12b4..574c3b6022, review clean after test-assertion fix; production code passed first review). createBoard reuses addColumn/addView/addRow/ensureGroupColumn/writeCell; factored shared pushDelta; resolveColumnIdByName/resolveCellsByColumnName; unknown cell column name -> throws (not silent).
- Task 8 (copilot tools database_read/create/update): in progress (base 574c3b6022)
- Task 8: COMPLETE (commits 574c3b6022..bbe18d6897, review clean, no Critical/Important). database_read/create/update defineTool wrappers mirroring doc-write; all failure paths -> toolError; DatabaseOpSchema for update; operations cast safe (post-validation). MINORs (final triage): no test for missing user/workspace guard; empty-string block_id falls through to list-boards.
- Task 9 (wire tools into runtime + prompt): in progress (base bbe18d6897)
- Task 9: COMPLETE (commits bbe18d6897..fd994810fd, review clean, no Critical/Important). index exports + PromptToolsSchema + tool-runtime switch (read ungated, create/update canary-gated) + 9th ctor param (both raw call sites updated) + built-in.json config.tools (valid). MINOR (final triage): first wiring gate-test relies on env defaults (2nd test covers explicitly).
- Task 10 (CRDT concurrency test): in progress (base fd994810fd)
- Task 10: COMPLETE (test-only, no production changes). `database-concurrency.spec.ts`: writer delta A (`add_row` via `DatabaseWriter.applyOps` + `FakeStorage`) and independent concurrent-client delta B (raw-Yjs title edit on a separate `Y.Doc` loaded from the same base bin) merged onto fresh docs in both orders. tsc clean on the new file (64 pre-existing unrelated lines elsewhere, none database-related). `tsx` runtime smoke (ava can't execute on Node 24 here) confirmed both edits survive and both apply orders produce byte-identical merged binaries + deepEqual boards (CRDT commutativity, no lost update). Scratch smoke file deleted after verification. ALL 10 TASKS NOW COMPLETE.
