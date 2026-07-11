# Copilot Database/Kanban Management Tools — Design

**Status:** Approved (brainstorming complete, 2026-07-11)
**Branch:** `requesty-provider-spec` (fork `zebster-cmd/AFFiNE`)

## Goal

Let the AFFiNE AI copilot fully **manage `affine:database` boards (table + kanban) from chat** — read, create, and edit columns, rows/cards, cells, kanban card-moves, views, and deletes — via new **server-side** tools that mutate the Yjs document directly, bypassing the external markdown crate (`affine_doc_loader`) that currently rejects any document containing a database block.

## Background

- The copilot's document tools round-trip markdown through the Rust crate `affine_doc_loader`, whose write path **hard-fails on any document containing an `affine:database` block** (`unsupported block flavour: affine:database`). So today the AI can neither read a board's structure nor edit it, and cannot edit _any_ doc that contains one.
- A prior quick-win (commit `e58cb1a43f`) turned that crate error into an actionable message and surfaced omitted blocks in `doc_read`, but did not add database capability.
- The block model is well understood (see Data Model). `yjs` (`^13.6.27`) is already a backend dependency (`packages/backend/server/package.json`), so the mutations can happen server-side in Node without touching the Rust crate.

## Scope

**In scope (v1 — full management):**

- Read a board's structure (columns, rows, cells, views) as JSON.
- Create a new board (columns, a view, optional initial rows).
- Edit an existing board: add/update/delete columns, add/update/delete rows, set cell values, **move cards between kanban groups**, add views.

**Out of scope (later phases):**

- Inline "Ask AI" button on database blocks (frontend surface) — phase 2.
- Exotic property types: formula, relation/link-to-doc, rollup.
- Edgeless/mindmap generation, image generation.
- Forking `affine_doc_loader` to make `doc_update` tolerate database blocks (separate track).

## Data Model (as established by investigation)

`affine:database` block (BlockSuite model version 3, flavour `affine:database`, role `hub`):

- `prop:columns` — `ColumnDataType[]`, each `{ id, type, name, data }`. `type` ∈ preset ids (`title, rich-text, text, select, multi-select, number, checkbox, date, progress, link, created-time`, …). Select/multi-select store options in `data.options: [{ id, value, color }]`.
- `prop:cells` — `SerializedCells`: `{ [rowId]: { [columnId]: { columnId, value } } }`. The **title** column's value is not stored here — it is the row block's `prop:text`.
- `prop:views` — `ViewBasicDataType[]`, each `{ id, name, mode }`. Table view: `mode: 'table'`. Kanban view (`mode: 'kanban'`): additionally `groupBy` (references a column), `groupProperties: GroupProperty[]` (array order = group display order; each has `manuallyCardSort: string[]` = card order within the group), `header: { titleColumn, iconColumn, coverColumn }`.
- **Rows are child blocks** of the database block (`affine:paragraph` or `affine:list`). Row id = the child block id; row title = the child block's `prop:text` (a `Y.Text`). Row order = child order in `sys:children`.

Reference implementations to mirror (read-only in the repo, used as construction patterns):

- Notion-HTML importer `blocksuite/affine/blocks/database/src/adapters/notion-html.ts` — constructs `columns`/`cells`/`children`/`views` from external data.
- `blocksuite/affine/blocks/database/src/properties/*` and `data-view` `block-utils.ts` (`addProperty`, `updateCell`, `updateView`, `deleteRows`), `data-source.ts` (`propertyAdd`, `rowAdd`, `rowMove`, `cellValueChange`, `viewDataAdd`), `group-by-utils.ts` (`ensureKanbanGroupColumn` — default "Status" select `Todo/In Progress/Done`).

## Architecture

New server-side units in `packages/backend/server/src/core/doc/`:

- **`DatabaseReader`** — given a doc binary, produce a structured JSON projection of a board (or list boards in a doc). Pure read over a `Y.Doc`.
- **`DatabaseWriter`** — apply create/edit operations to a board by mutating the `Y.Doc`, then push the CRDT delta through the existing doc push path so live clients converge.

New copilot tools in `packages/backend/server/src/plugins/copilot/tools/`:

- `database-read.ts`, `database-create.ts`, `database-update.ts` — thin `defineTool` wrappers with permission checks, delegating to the reader/writer (pattern: `doc-read.ts` / `doc-write.ts`).

Wiring (per the tool-add checklist established in the investigation):

1. Export tools from `tools/index.ts`.
2. Add tool names (`databaseRead`, `databaseCreate`, `databaseUpdate`) to the `PromptToolsSchema` enum in `providers/types.ts`.
3. Add `case` handlers in `runtime/tool-runtime.ts` (write tools join the existing `env.dev || env.namespaces.canary` gate; read tool ungated).
4. Add the three names to the "Chat With AFFiNE AI" prompt `config.tools` in `packages/backend/native/src/llm/assets/prompts/built-in.json` (requires native rebuild).

### Concurrency model

`DatabaseWriter` mirrors the existing `DocWriter` delta pattern:

1. Load the current doc binary (via `DocReader.getDoc`).
2. `const doc = new Y.Doc(); Y.applyUpdate(doc, bin)`.
3. Capture `const before = Y.encodeStateVector(doc)`.
4. Apply all operations inside a single `doc.transact(() => { … })`.
5. `const update = Y.encodeStateAsUpdate(doc, before)` — the minimal delta.
6. Push via the same path `DocWriter` uses (`pushDocUpdates` + `emitDocUpdatesPushed`), which is CRDT-merge-safe against concurrent client edits.

## Tools

### `database_read`

Input: `{ doc_id: string, database_block_id?: string }`.

- With `database_block_id`: return `{ blockId, title, columns: [{ id, name, type, options? }], rows: [{ rowId, title, cells: { [columnName]: value } }], views: [{ id, name, mode, groupByColumnId?, groups?: [{ value, cardRowIds: string[] }] }] }`.
- Without it: return `{ databases: [{ blockId, title, viewModes: string[] }] }` so the model can choose.
  Permission: `Doc.Read`. Ungated.

### `database_create`

Input: `{ doc_id, title, columns: [{ name, type, options? }], view: { mode: 'table' | 'kanban', name?, groupByColumnName? }, rows?: [{ title?, cells?: { [columnName]: value } }] }`.

- Creates a new `affine:database` block appended under the doc's `affine:note`, with the given columns (a `title` column is always ensured), the requested view (kanban ensures a select group column, defaulting to a "Status" select if `groupByColumnName` is unset/not a select), and optional initial rows.
- Returns `{ blockId }`.
  Permission: `Doc.Update`. Gated (canary).

### `database_update`

Input: `{ doc_id, database_block_id, operations: Operation[] }`. Operations (flat, batched, applied in order in one transaction):

- `{ op: 'add_column', name, type, options? }` → returns nothing structural; new column id available to later reads.
- `{ op: 'update_column', columnId, name?, options? }`
- `{ op: 'delete_column', columnId }`
- `{ op: 'add_row', title?, cells? }`
- `{ op: 'update_cell', rowId, columnId, value }`
- `{ op: 'move_card', rowId, toGroupValue }` (kanban): set the group column's cell for `rowId` to `toGroupValue` (creating the option if missing) and reorder `manuallyCardSort` so the card lands in that group.
- `{ op: 'delete_row', rowId }`
- `{ op: 'add_view', mode, name?, groupByColumnId? }`
  Returns `{ success: true, blockId, applied: N }`.
  Permission: `Doc.Update`. Gated (canary).

## Value Codec

A `CELL_CODECS` table maps property `type` → `{ encode(modelValue): storedValue, decode(storedValue): modelValue }`:

- `title` → row child block `prop:text` (`Y.Text`), not stored in `cells`.
- `rich-text`, `text` → `Y.Text` / string.
- `select` → option id; `encode` auto-creates a missing option (`{ id, value, color }`) on the column's `data.options`.
- `multi-select` → option id[]; auto-creates missing options.
- `number`, `progress` → number.
- `checkbox` → boolean.
- `date` → epoch-ms number.
- `link` → string (URL).
- `created-time`, `updated-time` → **read-only**; writes return a clear error.
  Unknown/unsupported types → a clear `toolError` naming the type.

## Error Handling

All failures return structured `toolError`s the model can recover from:

- Missing/inaccessible doc, or `database_block_id` not found in the doc → clear "not found" naming the id.
- Unknown `columnId` / `rowId` / view id in an operation → clear error naming it (and, where cheap, listing valid ids).
- Type mismatch (e.g. text into a number cell) → clear error naming column + expected type.
- Write to a read-only column → clear error.
- Block vanished between read and write → "database block no longer exists" error.
  Operations in a `database_update` are validated up front where possible; a mid-batch failure aborts the whole transaction (no partial writes) and reports which op failed.

## Permissions & Gating

- `database_read`: assert `Doc.Read`; always available.
- `database_create`, `database_update`: assert `Doc.Update`; gated behind the existing write-tool flag `env.dev || env.namespaces.canary` in `tool-runtime.ts` (the deployment builds `BUILD_TYPE: canary`, so they are active). This keeps behavior consistent with `doc_create`/`doc_update`.

## Testing

ava unit tests (run in CI on Node 22.23; not locally on Node 24 — same constraint as existing copilot specs), against fixture `Y.Doc` binaries:

- `DatabaseReader`: known board → expected JSON; kanban groups → expected `cardRowIds` order; multi-board doc → list.
- `DatabaseWriter` per op: `add_column`/`update_column`/`delete_column`, `add_row`/`delete_row`, `update_cell` (per codec type), `move_card` (group cell updated **and** `manuallyCardSort` reordered), `add_view`.
- `database_create` → `database_read` round-trip (columns/rows/view match input).
- Value codec: per-type encode/decode, and select/multi-select option auto-creation.
- Concurrency: apply two overlapping deltas (one from the writer, one simulating a concurrent client edit) and assert the merged `Y.Doc` preserves both, no lost updates.
- Tool layer: permission-denied returns `toolError`; unknown ids return the naming errors.

## Deployment

Backend (`core/doc/*`, `plugins/copilot/tools/*`, `providers/types.ts`, `tool-runtime.ts`) plus `built-in.json` (native rebuild for the tool-name wiring). Ships via the existing CI image build (`.github/workflows/requesty-selfhost-image.yml`) → Coolify redeploy — the same loop used for prior changes.

## File Structure

- Create `packages/backend/server/src/core/doc/database-reader.ts` — `DatabaseReader`.
- Create `packages/backend/server/src/core/doc/database-writer.ts` — `DatabaseWriter` + `CELL_CODECS`.
- Modify `packages/backend/server/src/core/doc/index.ts` — export the new units.
- Create `packages/backend/server/src/plugins/copilot/tools/database-read.ts`, `database-create.ts`, `database-update.ts`.
- Modify `packages/backend/server/src/plugins/copilot/tools/index.ts` — export new tools.
- Modify `packages/backend/server/src/plugins/copilot/providers/types.ts` — add tool names to `PromptToolsSchema`.
- Modify `packages/backend/server/src/plugins/copilot/runtime/tool-runtime.ts` — register the three tools (write tools gated).
- Modify `packages/backend/native/src/llm/assets/prompts/built-in.json` — add tool names to the chat prompt.
- Create tests under `packages/backend/server/src/__tests__/copilot/` (reader/writer/tools) — note the file glob for the existing `test:copilot` script.

## Global Constraints

- Server-side only; use the `yjs` package already in `packages/backend/server` — do NOT add dependencies or touch the Rust `affine_doc_loader` crate.
- Mutations must use the delta-against-state-vector push pattern of the existing `DocWriter` (CRDT-merge-safe); never overwrite the whole doc.
- Write tools (`database_create`, `database_update`) are gated behind `env.dev || env.namespaces.canary`, exactly like `doc_create`/`doc_update`; the read tool is ungated.
- No partial writes: a `database_update` batch is one Yjs transaction — all ops apply or none do.
- All tool failures return structured `toolError`s, never throw raw crate/library errors to the model.
- Property types supported in v1: title, rich-text/text, select, multi-select, number, progress, checkbox, date, link (created-time/updated-time read-only). Formula/relation/rollup are out of scope.
