## 1. Foundations & fixtures

- [x] 1.1 Add a favorites-doc fixture: storage id `userdata$<userId>$<workspaceId>$favorite`, row = top-level `Y.Map` named `doc:<docId>` with fields `key`/`index`; cover the not-yet-exists case (writer creates a fresh `Y.Doc` on first write)
- [x] 1.2 Build test fixtures: a workspace root doc binary (with `meta.pages[]` + `meta.properties.tags.options`), a `db$<ws>$docProperties` binary, a `db$<ws>$docCustomPropertyInfo` binary, and a per-doc binary with an inline ref + embed block
- [x] 1.3 Add a shared `applyToBinary`/`pushDelta` helper (or reuse the one in `database-writer.ts`) usable across the new readers/writers

## 2. Properties reader (TDD)

- [x] 2.1 Failing test: read tags (ids → resolved name+color) from the root doc
- [x] 2.2 Failing test: read journal/mode/custom values from `docProperties`, resolving names/types from `docCustomPropertyInfo`
- [x] 2.3 Failing test: read favorite state from the userspace doc; read title/trash from root doc
- [x] 2.4 Implement `PropertiesReader` (aggregates all zones into one resolved JSON view) to pass 2.1–2.3

## 3. Properties writer — value codec + core metadata (TDD)

- [x] 3.1 Failing tests for the string codec (text/number/checkbox/date/tags encode→string, best-effort decode by type)
- [x] 3.2 Failing tests: `set_title`, `set_trash`, `set_journal` (`YYYY-MM-DD`), `set_mode` (`page`|`edgeless`)
- [x] 3.3 Implement codec + core-metadata ops in `PropertiesWriter` (delta push per affected doc)

## 4. Properties writer — tags & custom properties (TDD)

- [x] 4.1 Failing tests: `create_tag` (adds `{id,value,color}` to root options), `add_tag`/`remove_tag` by name, missing-tag error, ambiguous-name error
- [x] 4.2 Failing tests: `define_property` (writes `docCustomPropertyInfo`), `set_property` by name, undefined-property error, unsupported-type (`select`) error
- [x] 4.3 Failing test: `set_favorite` writes the userspace favorites doc (acting-user scoped)
- [x] 4.4 Implement tag/property/favorite ops
- [x] 4.5 Failing test: mid-batch invalid op aborts the whole batch (no partial write across docs)
- [x] 4.6 Implement up-front batch validation + atomic apply (grouped per target doc)

## 5. Links reader (TDD)

- [x] 5.1 Failing test: outgoing links via `IndexerService` (`docId==X ∧ exists refDocId`), resolved titles
- [x] 5.2 Failing test: backlinks via aggregate (`refDocId==X` group by `docId`)
- [x] 5.3 Implement `LinksReader` over `IndexerService`

## 6. Links writer (TDD)

- [x] 6.1 Failing test: `create_link` appends an `affine:embed-linked-doc` block (`prop:pageId`) under the note; returns block id
- [x] 6.2 Failing test: `create_link` inline mode inserts a `{reference:{type:'LinkedPage',pageId}}` space-delta at an anchor
- [x] 6.3 Failing tests: `remove_link` (embed by id; inline by delta-walk match on pageId), `retarget_link`
- [x] 6.4 Failing test: `create_doc_and_link` creates + registers a new doc (reuse `DocWriter.createDoc`) and links to it
- [x] 6.5 Failing tests: missing target/anchor/blockId → a clear error the tool layer wraps as `toolError` (name→id _ambiguity_ resolution is intentionally the tool layer's job per Decision 4/5 — `applyOps` takes ids only, so there is no name ambiguity to exercise at this layer; see task 7)
- [x] 6.6 Implement `LinksWriter`

## 7. Copilot tools (defineTool wrappers)

- [x] 7.1 `doc-properties-read.ts` (Doc.Read, ungated) — permission check + delegate to `PropertiesReader`
- [x] 7.2 `doc-properties-update.ts` (Doc.Update, gated) — batched ops → `PropertiesWriter`
- [x] 7.3 `doc-links-read.ts` (Doc.Read, ungated) → `LinksReader`
- [x] 7.4 `doc-links-update.ts` (Doc.Update, gated) → `LinksWriter`
- [x] 7.5 Tool-layer tests: permission-denied → `toolError`; unknown ids → naming errors

## 8. Runtime & prompt wiring

- [x] 8.1 Export the four tools from `plugins/copilot/tools/index.ts`
- [x] 8.2 Add `docPropertiesRead/docPropertiesUpdate/docLinksRead/docLinksUpdate` to `PromptToolsSchema` (`providers/types.ts`)
- [x] 8.3 Register cases in `runtime/tool-runtime.ts` (inject new services; gate the two write tools behind `env.dev || env.namespaces.canary`)
- [x] 8.4 Add the four tool names to the "Chat With AFFiNE AI" prompt `config.tools` in `native/.../built-in.json`; native rebuild is CI's job (not done locally, per task brief)
- [x] 8.5 Export new units from `core/doc/index.ts` — `DocPropertiesReader`/`DocPropertiesWriter`/`DocLinksWriter` are provided+exported there; `DocLinksReader` is provided+exported from `plugins/indexer/index.ts` instead (its `IndexerService` dependency would otherwise close a static import cycle back through `core/index.ts` -> `core/auth` -> `core/doc`; see the comment left in both files)

## 9. Verify

- [x] 9.1 Round-trip test: `doc_properties_update` then `doc_properties_read` reflects every attribute set (covered at the writer/reader unit level; the `doc_properties_update`/`doc_properties_read` tool wrappers are Track A tasks 7-8, not yet built)
- [x] 9.2 Concurrency test: overlapping delta (writer vs. simulated client edit) merges without lost updates
- [ ] 9.3 Run the copilot ava suite (`packages/backend/server/src/__tests__/copilot/`, Node 22 in CI) — all green
- [ ] 9.4 Manually confirm via the copilot: set tags/properties/journal/mode/favorite and create/read/remove a link on a real doc
