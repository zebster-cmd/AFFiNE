# Copilot Database/Kanban Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AFFiNE copilot server-side tools to read, create, and edit `affine:database` boards (table + kanban) by mutating the Yjs doc directly.

**Architecture:** New `DatabaseReader`/`DatabaseWriter` in `core/doc/` operate on a `Y.Doc` (via the `yjs` package, already a dep), reading/writing the `blocks` Y.Map. The writer applies ops in one `Y.transaction`, encodes the delta against the pre-edit state vector, and pushes it through the existing `PgWorkspaceDocStorageAdapter.pushDocUpdates` + `emitDocUpdatesPushed` path (CRDT-merge-safe). Three `defineTool` wrappers (`database_read/create/update`) expose them to the copilot.

**Tech Stack:** TypeScript, NestJS, `yjs` ^13.6.27, zod, ava (tests, run in CI on Node 22.23).

## Global Constraints

- Server-side only; use the `yjs` package already in `packages/backend/server` — do NOT add dependencies or touch the Rust `affine_doc_loader` crate.
- Mutations use the delta-against-state-vector push pattern (CRDT-merge-safe); never overwrite the whole doc.
- Write tools (`database_create`, `database_update`) are gated behind `env.dev || env.namespaces.canary`, exactly like `doc_create`/`doc_update`; the read tool is ungated.
- No partial writes: a `database_update` batch is one `Y.transaction` — all ops apply or none.
- All tool failures return structured `toolError`s (from `tools/error.ts`), never raw thrown errors.
- v1 property types: `title, rich-text, text, select, multi-select, number, progress, checkbox, date, link` (`created-time`/`updated-time` read-only). Formula/relation/rollup are out of scope.

## Yjs block layout (confirmed from `affine_doc_loader` read source)

- Blocks live in the doc's `blocks` map: `ydoc.getMap('blocks')`. Each block id → a `Y.Map` with keys `sys:id` (string), `sys:flavour` (string, e.g. `affine:database`, `affine:paragraph`, `affine:note`), `sys:version` (number), `sys:children` (`Y.Array<string>` of child block ids), and `prop:*`.
- Database block (`sys:flavour === 'affine:database'`): `prop:columns` (`Y.Array` of `{ id, type, name, data }`; select/multi-select options at `data.options: [{ id, value, color }]`), `prop:cells` (`Y.Map`: `rowId → Y.Map(columnId → Y.Map{ columnId, value })`), `prop:views` (`Y.Array` of `{ id, name, mode, ...}`), `prop:title` (`Y.Text`).
- **Rows** = the database block's `sys:children`. Row id = child block id. Row title = the child block's `prop:text` (`Y.Text`). Non-title cells live in `prop:cells[rowId][columnId].value`.
- Reference for exact read semantics: `affine_doc_loader-0.1.2/src/read/database.rs` (columns L191-209, cells L826, rows via `collect_child_ids`). Reference for construction: `blocksuite/affine/blocks/database/src/adapters/notion-html.ts`.

---

### Task 1: Shared types + test fixture helper

**Files:**

- Create: `packages/backend/server/src/core/doc/database-types.ts`
- Create: `packages/backend/server/src/__tests__/copilot/fixtures/database-doc.ts`
- Test: `packages/backend/server/src/__tests__/copilot/database-fixture.spec.ts`

**Interfaces:**

- Produces: `PropertyType` (union of the v1 type strings); `ColumnJSON = { id: string; name: string; type: PropertyType; options?: { id: string; value: string; color?: string }[] }`; `RowJSON = { rowId: string; title: string; cells: Record<string, unknown> }`; `ViewJSON = { id: string; name: string; mode: string; groupByColumnId?: string; groups?: { value: string; cardRowIds: string[] }[] }`; `BoardJSON = { blockId: string; title: string; columns: ColumnJSON[]; rows: RowJSON[]; views: ViewJSON[] }`. Operation union `DatabaseOp` (the 8 ops from the spec, discriminated on `op`). A test helper `buildBoardDoc(spec): Uint8Array` that constructs a `Y.Doc` binary containing an `affine:page`→`affine:note`→`affine:database` with given columns/rows/views, for use by reader/writer tests.

- [ ] **Step 1: Write the failing test** (`database-fixture.spec.ts`)

```ts
import test from 'ava';
import * as Y from 'yjs';
import { buildBoardDoc } from './fixtures/database-doc';

test('buildBoardDoc produces a doc with a database block and its rows as children', t => {
  const bin = buildBoardDoc({
    title: 'Tasks',
    columns: [
      { id: 'c_title', name: 'Title', type: 'title' },
      { id: 'c_status', name: 'Status', type: 'select', options: [{ id: 'o_todo', value: 'Todo' }] },
    ],
    rows: [{ rowId: 'r1', title: 'First', cells: { c_status: 'o_todo' } }],
    views: [{ id: 'v1', name: 'Table', mode: 'table' }],
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bin);
  const blocks = doc.getMap('blocks');
  const dbId = [...blocks.keys()].find(id => (blocks.get(id) as Y.Map<any>).get('sys:flavour') === 'affine:database');
  t.truthy(dbId);
  const db = blocks.get(dbId!) as Y.Map<any>;
  t.deepEqual((db.get('sys:children') as Y.Array<string>).toArray(), ['r1']);
  const cells = db.get('prop:cells') as Y.Map<any>;
  t.is((cells.get('r1') as Y.Map<any>).get('c_status').get('value'), 'o_todo');
});
```

- [ ] **Step 2: Run it, verify it fails** — Run: `yarn workspace @affine/server exec ava src/__tests__/copilot/database-fixture.spec.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `database-types.ts`** — the type unions above (no runtime code, just `export type`s + a zod schema `DatabaseOpSchema` for the op union used later by the update tool).
- [ ] **Step 4: Implement `fixtures/database-doc.ts`** — `buildBoardDoc(spec)` builds a `Y.Doc`, `getMap('blocks')`, inserts a page block (`sys:flavour: 'affine:page'`, children `['note']`), a note block (`children: [dbId]`), and a database block whose `sys:children` = row ids, `prop:columns` = `Y.Array` of column objects (options nested under `data.options`), `prop:cells` = `Y.Map` per the layout, `prop:views` = `Y.Array`, `prop:title` = `Y.Text(title)`. Each row → a child `affine:paragraph` block with `prop:text` = `Y.Text(row.title)`. Return `Y.encodeStateAsUpdate(doc)`. Use fixed ids from the spec (no random ids — deterministic tests).
- [ ] **Step 5: Run test, verify pass.** Run the same command. Expected: PASS.
- [ ] **Step 6: Commit** — `git add packages/backend/server/src/core/doc/database-types.ts packages/backend/server/src/__tests__/copilot/fixtures/database-doc.ts packages/backend/server/src/__tests__/copilot/database-fixture.spec.ts && git commit -m "feat(copilot): database tool shared types + test fixture"`

---

### Task 2: Value codec (`CELL_CODECS`)

**Files:**

- Create: `packages/backend/server/src/core/doc/database-codec.ts`
- Test: `packages/backend/server/src/__tests__/copilot/database-codec.spec.ts`

**Interfaces:**

- Consumes: `PropertyType`, `ColumnJSON` (Task 1).
- Produces: `encodeCell(column: StoredColumn, modelValue: unknown, ydoc: Y.Doc): unknown` and `decodeCell(column: StoredColumn, stored: unknown): unknown`, where `StoredColumn` is the in-doc column object (`{ id, type, name, data }`). `encodeCell` for `select`/`multi-select` auto-creates a missing option on `column.data.options` (mutating it) and returns the option id(s). `title`/`created-time`/`updated-time` throw a typed `CodecError` when passed to `encodeCell` (title handled by row text; time columns read-only). Export `isReadOnlyType(type): boolean`.

- [ ] **Step 1: Write failing tests** — select auto-creates option and returns its id; multi-select returns id array; number passes through; checkbox coerces to boolean; date accepts epoch-ms; `created-time` throws `CodecError`; decode reverses each. (Write one `test()` per case with concrete asserts.)
- [ ] **Step 2: Run, verify fail** — `yarn workspace @affine/server exec ava src/__tests__/copilot/database-codec.spec.ts`.
- [ ] **Step 3: Implement `database-codec.ts`** — a `Record<PropertyType, Codec>` table; select/multi-select option lookup by `value` (case-insensitive), else push `{ id: nanoid(), value, color: pickColor() }`. Use `nanoid` (already a dep) for option ids; `pickColor()` returns a fixed palette entry (mirror the editor's default option colors — a static list is fine).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(copilot): database cell value codec"`

---

### Task 3: `DatabaseReader`

**Files:**

- Create: `packages/backend/server/src/core/doc/database-reader.ts`
- Modify: `packages/backend/server/src/core/doc/index.ts` (export `DatabaseReader`)
- Test: `packages/backend/server/src/__tests__/copilot/database-reader.spec.ts`

**Interfaces:**

- Consumes: `buildBoardDoc` (Task 1), `decodeCell`/`StoredColumn` (Task 2), `BoardJSON`/`ColumnJSON`/`RowJSON`/`ViewJSON` (Task 1).
- Produces: `class DatabaseReader` with `readBoardFromBinary(bin: Uint8Array, blockId: string): BoardJSON` and `listBoardsFromBinary(bin: Uint8Array): { blockId: string; title: string; viewModes: string[] }[]`. (Pure functions over a binary — no NestJS deps yet, so they are trivially unit-testable. The tool layer in Task 8 supplies the binary via `DocReader`.)

- [ ] **Step 1: Write failing tests** — `readBoardFromBinary` on a `buildBoardDoc` fixture returns columns (id/name/type/options), rows (rowId/title/cells with decoded values), and views; for a kanban view fixture (`mode:'kanban'`, groupBy = status column, groupProperties with card order) it returns `groups: [{ value, cardRowIds }]`. `listBoardsFromBinary` on a two-database doc returns both.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `database-reader.ts`** — `new Y.Doc()`, `applyUpdate`, `getMap('blocks')`; find the block by id; read `prop:columns`/`prop:cells`/`prop:views`; rows from `sys:children` (title = child block `prop:text` `.toString()`, other cells via `decodeCell`); kanban groups by reading the view's `groupProperties` + `manuallyCardSort` and resolving each card's group cell. Column type strings map directly to `PropertyType`. Export from `index.ts`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(copilot): DatabaseReader board JSON projection"`

---

### Task 4: `DatabaseWriter` foundation (load / transact / delta helper + column ops)

**Files:**

- Create: `packages/backend/server/src/core/doc/database-writer.ts`
- Modify: `packages/backend/server/src/core/doc/index.ts` (export `DatabaseWriter`)
- Test: `packages/backend/server/src/__tests__/copilot/database-writer-columns.spec.ts`

**Interfaces:**

- Consumes: `encodeCell` (Task 2), `DatabaseReader.readBoardFromBinary` (Task 3, for test assertions), `PgWorkspaceDocStorageAdapter` + `EventBus` (constructor, mirror `DocWriter` at `writer.ts:36-43`).
- Produces: `class DatabaseWriter` with a private `applyToBinary(bin: Uint8Array, blockId: string, mutate: (ctx: BoardCtx) => void): Uint8Array` that loads the doc, captures the state vector, runs `mutate` inside `doc.transact`, and returns `Y.encodeStateAsUpdate(doc, beforeSV)`. `BoardCtx = { doc, blocks, db, columns, cells, views }`. Public `applyOps(workspaceId, docId, blockId, ops: DatabaseOp[], editorId?)` that fetches via `storage.getDoc`, calls `applyToBinary`, pushes via `storage.pushDocUpdates` + `emitDocUpdatesPushed` (copy the emit helper from `writer.ts`). This task implements only the `add_column`/`update_column`/`delete_column` ops inside `applyToBinary`'s op switch.

- [ ] **Step 1: Write failing tests** (unit, against binaries — no DB): a helper that calls the pure `applyToBinary` directly. `add_column` appends to `prop:columns` and is visible via `readBoardFromBinary`; `update_column` renames; `delete_column` removes the column and its cells. Assert the returned binary is a _delta_ (smaller than a full doc) by applying it onto the original and re-reading.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the foundation + column ops. Delete-column must also purge `prop:cells[*][columnId]`. Use `nanoid` for new column ids.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(copilot): DatabaseWriter foundation + column ops"`

---

### Task 5: `DatabaseWriter` row + cell ops

**Files:**

- Modify: `packages/backend/server/src/core/doc/database-writer.ts`
- Test: `packages/backend/server/src/__tests__/copilot/database-writer-rows.spec.ts`

**Interfaces:**

- Consumes: Task 4 foundation, `encodeCell` (Task 2).
- Produces: `add_row` (creates a child `affine:paragraph` block with `prop:text` = row title, appends its id to the db block's `sys:children`, writes any `cells` via `encodeCell`), `update_cell` (sets `prop:cells[rowId][columnId] = { columnId, value }`; title column writes the row child's `prop:text` instead), `delete_row` (removes child id from `sys:children`, deletes the child block and `prop:cells[rowId]`).

- [ ] **Step 1: Write failing tests** — `add_row` with cells → reader shows the new row + decoded cell; `update_cell` on a select auto-creates the option; `update_cell` on the title column changes the row title; `delete_row` removes it and its cells; writing to a `created-time` column returns/throws a codec error surfaced as a rejected op.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the three ops. New row/child block ids via `nanoid`; child block `sys:flavour: 'affine:paragraph'`, `sys:version` matching the fixture, empty `sys:children`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(copilot): DatabaseWriter row + cell ops"`

---

### Task 6: `DatabaseWriter` kanban ops (`move_card`, `add_view`) + group helpers

**Files:**

- Modify: `packages/backend/server/src/core/doc/database-writer.ts`
- Test: `packages/backend/server/src/__tests__/copilot/database-writer-kanban.spec.ts`

**Interfaces:**

- Consumes: Task 4/5.
- Produces: `add_view` (append to `prop:views` with `{ id: nanoid(), name, mode }`, and for kanban set `groupBy` to the given column + initialize `groupProperties`); `move_card` (kanban: `encodeCell` the group column cell for `rowId` to the target group value — auto-creating the option — and update the target view's `manuallyCardSort`/`groupProperties` so the card lands in that group). Helper `ensureGroupColumn(ctx, view)` mirroring the editor's default "Status" select (`Todo/In Progress/Done`) when a kanban view lacks a group column.

- [ ] **Step 1: Write failing tests** — `add_view` mode `kanban` on a board creates a kanban view with a group column; `move_card` updates the row's group cell AND places its id in the destination group's card order; moving to a new group value creates the option.
- [ ] **Step 2: Run, verify fail.** **Step 3: Implement.** Reference the kanban view shape in `blocksuite/affine/data-view/src/view-presets/kanban/define.ts` (`groupBy`, `groupProperties[].manuallyCardSort`). **Step 4: Run, verify pass.** **Step 5: Commit** — `git commit -m "feat(copilot): DatabaseWriter kanban move_card + add_view"`

---

### Task 7: `DatabaseWriter.createBoard`

**Files:**

- Modify: `packages/backend/server/src/core/doc/database-writer.ts`
- Test: `packages/backend/server/src/__tests__/copilot/database-writer-create.spec.ts`

**Interfaces:**

- Consumes: Task 4-6.
- Produces: `createBoard(workspaceId, docId, spec: { title; columns; view; rows? }, editorId?): Promise<{ blockId: string }>` — loads the doc, finds the `affine:note` block, appends a new `affine:database` block (ensuring a `title` column; building columns/view/rows via the same helpers as the ops), pushes the delta. Kanban view ensures a select group column (default "Status").

- [ ] **Step 1: Write failing test** — `createBoard` then `readBoardFromBinary` (via a fake storage returning the pushed binary) round-trips columns, rows, and the view; kanban spec yields a kanban view with a group column.
- [ ] **Step 2-4: fail → implement → pass.** Use a fake `PgWorkspaceDocStorageAdapter` (in-memory: `getDoc` returns the current bin, `pushDocUpdates` applies the delta and stores it) so this is a unit test.
- [ ] **Step 5: Commit** — `git commit -m "feat(copilot): DatabaseWriter createBoard"`

---

### Task 8: Copilot tools (`database_read` / `database_create` / `database_update`)

**Files:**

- Create: `packages/backend/server/src/plugins/copilot/tools/database-read.ts`, `database-create.ts`, `database-update.ts`
- Test: `packages/backend/server/src/__tests__/copilot/database-tools.spec.ts`

**Interfaces:**

- Consumes: `DatabaseReader`/`DatabaseWriter`, `defineTool` (`tools/tool.ts`), `toolError` (`tools/error.ts`), `PermissionAccess`, `DocReader` (for `database_read` to fetch the binary — mirror `doc-read.ts:58-62`), `CopilotChatOptions` (`tools/types.ts`). The `database_update` input schema uses `DatabaseOpSchema` (Task 1).
- Produces: `buildDatabaseReadHandler(ac, docReader)`, `buildDatabaseCreateHandler(ac, writer)`, `buildDatabaseUpdateHandler(ac, writer)` and the matching `createDatabaseReadTool/createDatabaseCreateTool/createDatabaseUpdateTool` (mirror `doc-write.ts` structure: permission assert → delegate → `try/catch`→`toolError`). Read asserts `Doc.Read`; create/update assert `Doc.Update`.

- [ ] **Step 1: Write failing tests** — with a fake `PermissionAccess` (allow) + fake `DocReader`/`DatabaseWriter`, the read tool returns board JSON; the update tool applies ops and returns `{ success, blockId, applied }`; a permission-denied fake returns a `toolError`; an unknown-block error surfaces as a `toolError`.
- [ ] **Step 2-4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(copilot): database_read/create/update tools"`

---

### Task 9: Wire tools into the runtime + prompt

**Files:**

- Modify: `packages/backend/server/src/plugins/copilot/tools/index.ts` (export the three tools)
- Modify: `packages/backend/server/src/plugins/copilot/providers/types.ts:77-97` (add `'databaseRead' | 'databaseCreate' | 'databaseUpdate'` to `PromptToolsSchema`)
- Modify: `packages/backend/server/src/plugins/copilot/runtime/tool-runtime.ts` (add `case 'databaseRead' | 'databaseCreate' | 'databaseUpdate'`; put the two write tools inside the existing `env.dev || env.namespaces.canary` gate at ~L94-99; instantiate with the DI'd `DatabaseReader`/`DatabaseWriter`/`DocReader`/`PermissionAccess`)
- Modify: `packages/backend/native/src/llm/assets/prompts/built-in.json` ("Chat With AFFiNE AI" `config.tools`: add the three names)
- Modify: the copilot module providers (wherever `DatabaseReader`/`DatabaseWriter` must be registered for DI — mirror how `DocReader`/`DocWriter` are provided)
- Test: `packages/backend/server/src/__tests__/copilot/database-tools-wiring.spec.ts`

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Write failing test** — `PromptToolsSchema` parses the three new names; a minimal `ToolRuntime.getTools({ tools: ['databaseRead'] , …})` returns a tool under key `database_read`. (Gate: assert the write tools appear when the canary/dev env flag is on.)
- [ ] **Step 2-4: fail → implement → pass.** Confirm `built-in.json` still valid JSON (`node -e "JSON.parse(...)"`).
- [ ] **Step 5: Commit** — `git commit -m "feat(copilot): wire database tools into runtime + chat prompt"`

---

### Task 10: Concurrency + end-to-end round-trip tests

**Files:**

- Test: `packages/backend/server/src/__tests__/copilot/database-concurrency.spec.ts`

**Interfaces:**

- Consumes: `DatabaseWriter`, `buildBoardDoc`, `DatabaseReader`.

- [ ] **Step 1: Write test** — build a board binary; produce writer delta A (`add_row`) against it; independently produce a concurrent client edit B (`update_cell` on a different row) by mutating a separate `Y.Doc` loaded from the same binary and encoding its delta; apply both deltas onto a fresh doc in both orders; assert the final board reflects BOTH edits (no lost update) regardless of order.
- [ ] **Step 2: Run, verify pass** (this is the correctness guarantee; implementation already exists).
- [ ] **Step 3: Commit** — `git commit -m "test(copilot): database CRDT concurrency merge"`

---

## Notes for implementers

- Tests are ava and run in CI on Node 22.23 (`yarn workspace @affine/server exec ava <file>`); they will not run on this machine's Node 24 — that is expected. Write them anyway; CI is the gate.
- Pure-binary unit tests (Tasks 1-7, 10) need no Postgres/Redis — keep them dependency-free by testing `readBoardFromBinary`/`applyToBinary`/`createBoard` (with an in-memory fake storage), NOT the NestJS-wired services.
- Every op mutates Yjs types in place (`Y.Array.push`, `Y.Map.set`, `Y.Text`); never replace a whole `prop:*` container unless deleting it.
- Match `sys:version` values to what `buildBoardDoc` uses (read them from a real exported doc if in doubt; the fixture is the source of truth for tests).
