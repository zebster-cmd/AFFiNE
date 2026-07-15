## Context

The copilot already has a proven recipe for server-side, CRDT-safe mutation tools: `DatabaseReader`/`DatabaseWriter` in `packages/backend/server/src/core/doc/` load a doc binary into a `Y.Doc`, capture a state vector, mutate inside one `doc.transact`, and push only the delta via `PgWorkspaceDocStorageAdapter.pushDocUpdates` + `emitDocUpdatesPushed`. Tools in `plugins/copilot/tools/` are `defineTool` (zod) wrappers with `PermissionAccess` checks, wired via four spots: `tools/index.ts`, `PromptToolsSchema` (`providers/types.ts`), a case in `runtime/tool-runtime.ts` (writes gated by `env.dev || env.namespaces.canary`), and the prompt's `config.tools` in `native/.../built-in.json` (native rebuild).

Investigation established exactly where doc attributes live and how to write them (all confirmed against the Rust ground truth):

- **Tags:** workspace root doc (id == workspaceId). A doc's tags are an id array in `meta.pages[]`; tag definitions are `{ id, value, color }` in `meta.properties.tags.options`.
- **Custom properties + journal + mode:** the ORM doc `db$<ws>$docProperties`, where each row is a top-level `Y.Map` keyed by the doc id and fields are flat primitives (all values stored as strings), including `journal` (`YYYY-MM-DD`), `primaryMode` (`page`|`edgeless`), and `custom:<propertyId>`.
- **Property definitions:** a _separate_ ORM doc `db$<ws>$docCustomPropertyInfo`, rows keyed by property id with `{ id, name, type, show, index, icon }`; valid user-creatable types are `text|number|checkbox|date|tags`.
- **Favorite:** a per-user userspace doc (`userdata$…$favorite`), not a doc-global flag.
- **Links:** inline `@`-refs are single-space deltas carrying `{ reference: { type:'LinkedPage', pageId } }` inside a block's `Y.Text`; block-level links are `affine:embed-linked-doc` (`prop:pageId`). Backlinks/outgoing are queryable via the `IndexerService` `ref_doc_id` field with no per-doc scan.

## Goals / Non-Goals

**Goals:**

- Four tools — `doc_properties_read/update`, `doc_links_read/update` — giving the AI full management of doc attributes and links, in one cohesive change.
- Reuse the `DatabaseWriter` delta-push pattern for every write; no full-doc overwrites; batched updates are atomic.
- Name-based referencing for tags/properties/link targets with id fallback and disambiguation errors.

**Non-Goals:**

- Edgeless/canvas element management.
- `select`/`multi-select` doc properties (those live only in database blocks).
- Forking `affine_doc_loader` or changing markdown round-tripping.
- Silent auto-creation of tags/properties (explicit ops only).

## Decisions

**Decision 1 — Reuse the YJS-direct `DatabaseWriter` pattern for all writes.** Every target (root doc, `docProperties`, `docCustomPropertyInfo`, favorites, per-doc content) is a normal doc in the same storage. A shared `applyToBinary`/`pushDelta` helper (already present in `database-writer.ts:381-440`) is the model. Rationale: the encodings are simple flat primitives; no need to extend the Rust native fns (chosen: YJS-direct in TS).

**Decision 2 — One aggregating `doc_properties_read` across three docs.** The read fetches the root doc (tags + title/trash), `docProperties` (journal/mode/custom values), `docCustomPropertyInfo` (to resolve property names/types), and the favorites doc, and returns one resolved JSON view. Rationale: the model wants one call to "see" a doc's attributes; resolving ids→names server-side keeps the tool ergonomic.

**Decision 3 — Batched, atomic `doc_properties_update` with per-zone routing.** A flat op list is validated up front, then applied inside a single logical unit. Because ops touch different docs, the writer groups ops by target doc and pushes one delta per affected doc (each still delta-against-state-vector). A validation failure in any op aborts the entire batch (no partial writes). Rationale: matches the database tools' "all or none" contract while honoring the multi-doc reality.

**Decision 4 — Name resolution with disambiguation errors; explicit create/define ops.** Tags/properties/targets accept a name (id fallback). Zero matches → actionable `toolError`; multiple matches → `toolError` listing candidates. New tags/properties require `create_tag`/`define_property`. Rationale: natural for the model, avoids workspace pollution (user's chosen policy).

**Decision 5 — Links: embed-block default, inline optional; reads via the indexer.** `create_link` appends an `affine:embed-linked-doc` block (mirrors `DatabaseWriter.createBoard`); inline `@`-ref mode needs an anchor (block id + offset). `doc_links_read` uses `IndexerService` (already injected into `tool-runtime.ts`). Editing/removing a _specific inline_ ref requires loading the doc and walking that block's deltas (the index gives block ids, not char offsets). Rationale: embed path is cheap and fully round-trippable; inline supports true in-prose mentions where an anchor is known.

**Decision 6 — Values persisted as strings.** All `docProperties` values (including number/checkbox/date) are stored via `String(value)`, matching the ORM. A tiny codec encodes on write and best-effort decodes on read using the property's declared type.

## Risks / Trade-offs

- **Writing the workspace root doc (large, hot).** → Only mutate the specific `meta.pages[]` entry and `meta.properties.tags.options`; delta push is minimal and CRDT-merge-safe against concurrent edits.
- **Favorites doc may not exist yet.** → On first write, create a fresh `Y.Doc` and push full state (do not reuse `DatabaseWriter`'s `NotFound`-on-empty behavior). Doc id/row shape are confirmed (see Resolved Decisions).
- **Inline reference edit/remove needs delta-walking.** → Scope inline edit/remove to an explicit anchor (block id); embed links (delete-by-id) are the recommended default in tool descriptions.
- **Index staleness for `doc_links_read`.** → Document that results reflect the last indexed snapshot; acceptable for a read tool.
- **Two-doc custom properties (value + definition).** → `set_property` requires a prior `define_property`; the read tool resolves names from the definition doc so the model always has context.
- **Native rebuild for prompt wiring.** → Same constraint as the database tools; batch the `built-in.json` change with those.

## Migration Plan

- Additive backend change; no data migration. New units under `core/doc/`, new tools under `plugins/copilot/tools/`, plus the four wiring edits.
- Write tools ship gated (`dev || canary`); the deployment builds `canary`, so they are active there while remaining off elsewhere.
- Ships via the existing CI image build → redeploy loop; the `built-in.json` edit requires a native rebuild.
- Rollback: remove the tool names from the prompt/enum (tools go dark) or revert the change; no persisted-state migration to undo.

## Resolved Decisions

- **Favorites (confirmed writable server-side):** storage doc id `userdata$<userId>$<workspaceId>$favorite` (userId = acting user's account id); row is a top-level `Y.Map` named `doc:<docId>` with flat string fields `key="doc:<docId>"` and `index=<fractional-index string>`. It lives in the same `PgWorkspaceDocStorageAdapter` as every other doc (verbatim docId, no rewrite), so the standard delta-push path works. Two implementation notes: (a) the favorites doc may not exist yet — the writer MUST create a fresh `Y.Doc` and push full state on first write instead of throwing `NotFound`; (b) `remove favorite` uses the `$$DELETED` soft-delete flag. `set_favorite` therefore stays in v1.
- **`doc_properties_update` return shape:** an applied-count summary plus the ids of any newly created tags/properties (so the model can reference them in a follow-up), matching `database_update`. Not a full re-resolved doc view.
- **Inline `create_link` anchor:** the AI names a target block (default: the doc's last paragraph); the reference is appended at the end of that block. No explicit character offset required. Embed-block links (the default mode) sidestep anchoring entirely.
- **Tags surface:** first-class ops only (`add_tag`/`remove_tag`/`create_tag`). `define_property` rejects the `tags` type with a `toolError` pointing at the tag ops, so there is exactly one way to manage tags.
