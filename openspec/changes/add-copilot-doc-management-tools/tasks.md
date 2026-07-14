## 1. Foundations & fixtures

- [ ] 1.1 Add a favorites-doc fixture: storage id `userdata$<userId>$<workspaceId>$favorite`, row = top-level `Y.Map` named `doc:<docId>` with fields `key`/`index`; cover the not-yet-exists case (writer creates a fresh `Y.Doc` on first write)
- [ ] 1.2 Build test fixtures: a workspace root doc binary (with `meta.pages[]` + `meta.properties.tags.options`), a `db$<ws>$docProperties` binary, a `db$<ws>$docCustomPropertyInfo` binary, and a per-doc binary with an inline ref + embed block
- [ ] 1.3 Add a shared `applyToBinary`/`pushDelta` helper (or reuse the one in `database-writer.ts`) usable across the new readers/writers

## 2. Properties reader (TDD)

- [ ] 2.1 Failing test: read tags (ids → resolved name+color) from the root doc
- [ ] 2.2 Failing test: read journal/mode/custom values from `docProperties`, resolving names/types from `docCustomPropertyInfo`
- [ ] 2.3 Failing test: read favorite state from the userspace doc; read title/trash from root doc
- [ ] 2.4 Implement `PropertiesReader` (aggregates all zones into one resolved JSON view) to pass 2.1–2.3

## 3. Properties writer — value codec + core metadata (TDD)

- [ ] 3.1 Failing tests for the string codec (text/number/checkbox/date/tags encode→string, best-effort decode by type)
- [ ] 3.2 Failing tests: `set_title`, `set_trash`, `set_journal` (`YYYY-MM-DD`), `set_mode` (`page`|`edgeless`)
- [ ] 3.3 Implement codec + core-metadata ops in `PropertiesWriter` (delta push per affected doc)

## 4. Properties writer — tags & custom properties (TDD)

- [ ] 4.1 Failing tests: `create_tag` (adds `{id,value,color}` to root options), `add_tag`/`remove_tag` by name, missing-tag error, ambiguous-name error
- [ ] 4.2 Failing tests: `define_property` (writes `docCustomPropertyInfo`), `set_property` by name, undefined-property error, unsupported-type (`select`) error
- [ ] 4.3 Failing test: `set_favorite` writes the userspace favorites doc (acting-user scoped)
- [ ] 4.4 Implement tag/property/favorite ops
- [ ] 4.5 Failing test: mid-batch invalid op aborts the whole batch (no partial write across docs)
- [ ] 4.6 Implement up-front batch validation + atomic apply (grouped per target doc)

## 5. Links reader (TDD)

- [ ] 5.1 Failing test: outgoing links via `IndexerService` (`docId==X ∧ exists refDocId`), resolved titles
- [ ] 5.2 Failing test: backlinks via aggregate (`refDocId==X` group by `docId`)
- [ ] 5.3 Implement `LinksReader` over `IndexerService`

## 6. Links writer (TDD)

- [ ] 6.1 Failing test: `create_link` appends an `affine:embed-linked-doc` block (`prop:pageId`) under the note; returns block id
- [ ] 6.2 Failing test: `create_link` inline mode inserts a `{reference:{type:'LinkedPage',pageId}}` space-delta at an anchor
- [ ] 6.3 Failing tests: `remove_link` (embed by id; inline by delta-walk match on pageId), `retarget_link`
- [ ] 6.4 Failing test: `create_doc_and_link` creates + registers a new doc (reuse `DocWriter.createDoc`) and links to it
- [ ] 6.5 Failing tests: ambiguous/missing target → `toolError`
- [ ] 6.6 Implement `LinksWriter`

## 7. Copilot tools (defineTool wrappers)

- [ ] 7.1 `doc-properties-read.ts` (Doc.Read, ungated) — permission check + delegate to `PropertiesReader`
- [ ] 7.2 `doc-properties-update.ts` (Doc.Update, gated) — batched ops → `PropertiesWriter`
- [ ] 7.3 `doc-links-read.ts` (Doc.Read, ungated) → `LinksReader`
- [ ] 7.4 `doc-links-update.ts` (Doc.Update, gated) → `LinksWriter`
- [ ] 7.5 Tool-layer tests: permission-denied → `toolError`; unknown ids → naming errors

## 8. Runtime & prompt wiring

- [ ] 8.1 Export the four tools from `plugins/copilot/tools/index.ts`
- [ ] 8.2 Add `docPropertiesRead/docPropertiesUpdate/docLinksRead/docLinksUpdate` to `PromptToolsSchema` (`providers/types.ts`)
- [ ] 8.3 Register cases in `runtime/tool-runtime.ts` (inject new services; gate the two write tools behind `env.dev || env.namespaces.canary`)
- [ ] 8.4 Add the four tool names to the "Chat With AFFiNE AI" prompt `config.tools` in `native/.../built-in.json`; rebuild native
- [ ] 8.5 Export new units from `core/doc/index.ts`

## 9. Verify

- [ ] 9.1 Round-trip test: `doc_properties_update` then `doc_properties_read` reflects every attribute set
- [ ] 9.2 Concurrency test: overlapping delta (writer vs. simulated client edit) merges without lost updates
- [ ] 9.3 Run the copilot ava suite (`packages/backend/server/src/__tests__/copilot/`, Node 22 in CI) — all green
- [ ] 9.4 Manually confirm via the copilot: set tags/properties/journal/mode/favorite and create/read/remove a link on a real doc
