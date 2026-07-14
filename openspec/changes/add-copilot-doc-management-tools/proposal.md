## Why

The AFFiNE copilot can read and edit doc _body_ content and manage database blocks, but it cannot manage anything you _attribute_ to a doc — its tags, custom properties, journal date, page/edgeless mode, favorite status, trash state — nor can it read or create links between docs. Today only the doc title is writable (`doc_update_meta`). This change gives the AI first-class management of a doc's metadata and its link graph, reusing the proven server-side `DatabaseWriter` delta-push pattern.

## What Changes

- **New tool `doc_properties_read`** (ungated): returns an aggregated view of a doc's attributes across all storage zones — title, trash, favorite, tags (resolved names + colors), custom properties (resolved names/types/values), journal date, and primary mode.
- **New tool `doc_properties_update`** (gated: `dev || canary`): batched operations in one CRDT transaction — `set_title`, `set_trash`, `set_journal`, `set_mode`, `set_favorite`, `add_tag`, `remove_tag`, `create_tag`, `set_property`, `define_property`. Tags/properties/values are referenced **by name** with id fallback; ambiguous names return a structured error listing candidates. New tags/properties are only created via the explicit `create_tag` / `define_property` ops (no silent auto-create).
- **New tool `doc_links_read`** (ungated): lists a doc's outgoing links and incoming backlinks via the existing indexer (`ref_doc_id`), with no per-doc scan.
- **New tool `doc_links_update`** (gated): `create_link` (default: append an `affine:embed-linked-doc` block; optional inline `<think>`-style @-reference mode), `remove_link`, `retarget_link`, and `create_doc_and_link` (create a new doc and link to it in one step).
- **Standard tool wiring** (the established 4-spot recipe): export from `tools/index.ts`, add names to `PromptToolsSchema`, register cases in `tool-runtime.ts` (writes gated), and add names to the chat prompt in `built-in.json` (native rebuild).
- Custom-property value types are `text | number | checkbox | date | tags` (values persisted as strings). **NOTE:** `select`/`multi-select` are _not_ doc properties — they only exist inside `affine:database` blocks (handled by the existing database tools).

## Capabilities

### New Capabilities

- `copilot-doc-properties`: The copilot can read and mutate a doc's attributes — core metadata (title, trash, favorite), tags (assign/remove/define), custom properties (set values, define new ones), journal date, and primary mode — across the workspace root doc, the `docProperties`/`docCustomPropertyInfo` ORM docs, and the per-user favorites doc.
- `copilot-doc-linking`: The copilot can read a doc's outgoing links and incoming backlinks, and create, retarget, or remove doc-to-doc links (embed blocks and inline references), including creating a new doc and linking to it in one step.

### Modified Capabilities

<!-- None: there are no existing specs under openspec/specs/. -->

## Impact

- **New backend units** in `packages/backend/server/src/core/doc/`:
  - A properties reader/writer over the root doc `meta` (tags), `db$<ws>$docProperties` (journal/mode/custom values), `db$<ws>$docCustomPropertyInfo` (property defs), and the userspace favorites doc.
  - A links reader (via `IndexerService`) and a links writer (embed-block + inline-reference mutations) over the doc's own `Y.Doc`.
- **New copilot tools** in `packages/backend/server/src/plugins/copilot/tools/`: `doc-properties-read.ts`, `doc-properties-update.ts`, `doc-links-read.ts`, `doc-links-update.ts`.
- **Wiring:** `tools/index.ts`, `providers/types.ts` (`PromptToolsSchema`), `runtime/tool-runtime.ts` (inject new services; gate writes), `packages/backend/native/src/llm/assets/prompts/built-in.json` (tool names → native rebuild).
- **Data model touched (read/write):** workspace root doc `meta.pages[]` + `meta.properties.tags.options`; `db$<ws>$docProperties` and `db$<ws>$docCustomPropertyInfo` ORM docs (flat primitive rows keyed by doc/property id); per-user favorites doc; per-doc `Y.Doc` (embed blocks + inline reference deltas). All writes use the CRDT delta-against-state-vector push pattern; no full-doc overwrites.
- **No changes** to the Rust `affine_doc_loader` crate; all mutations are YJS-direct in TypeScript.
- **Out of scope:** edgeless/canvas element management.
- **Tests:** server-side ava suite under `packages/backend/server/src/__tests__/copilot/` (CI Node 22).
