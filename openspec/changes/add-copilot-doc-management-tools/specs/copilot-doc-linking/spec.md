## ADDED Requirements

### Requirement: Read a doc's links and backlinks

The system SHALL provide a `doc_links_read` tool that returns a doc's outgoing links and incoming backlinks using the existing block index (`ref_doc_id`), without scanning every doc. It SHALL require `Doc.Read` permission and be ungated.

#### Scenario: List outgoing and incoming links

- **WHEN** `doc_links_read` is called with a `doc_id`
- **THEN** it returns the docs this doc links to (outgoing) and the docs that link to it (backlinks), each with source/target doc id, resolved title, and block id
- **AND** the result is produced from the indexer aggregate query, not a per-doc scan

#### Scenario: Index staleness is acknowledged

- **WHEN** the index has not yet caught up to a very recent edit
- **THEN** the tool returns the last-indexed link set (results reflect the indexed snapshot)

### Requirement: Create links between docs

The system SHALL provide a `doc_links_update` tool with a `create_link` op that adds a link from a source doc to a target doc, defaulting to an `affine:embed-linked-doc` block and optionally an inline `@`-reference. It SHALL require `Doc.Update` permission and be gated behind `env.dev || env.namespaces.canary`. Writes SHALL use the delta-against-state-vector push pattern.

#### Scenario: Create an embed-block link (default)

- **WHEN** `create_link` is called with a source `doc_id` and a target referenced by name or id
- **THEN** a new `affine:embed-linked-doc` block with `prop:pageId = <targetId>` is appended under the source doc's note
- **AND** the tool returns the new block id

#### Scenario: Create an inline @-reference link

- **WHEN** `create_link` is called in inline mode with an anchor (target block id and offset)
- **THEN** a single-space delta with `{ reference: { type: 'LinkedPage', pageId: <targetId> } }` is inserted into that block's `Y.Text`

#### Scenario: Ambiguous or missing target

- **WHEN** the target name matches zero or multiple docs
- **THEN** the tool returns a `toolError` (naming the missing target, or listing candidates for disambiguation)

### Requirement: Retarget and remove existing links

The system SHALL support `remove_link` and `retarget_link` ops. Embed-block links are addressed by block id; inline references are located by walking the anchor block's `Y.Text` deltas for a matching `reference.pageId`.

#### Scenario: Remove an embed-block link

- **WHEN** `remove_link` is called with the embed block's id
- **THEN** that block is removed from the doc

#### Scenario: Retarget a link

- **WHEN** `retarget_link` is called for an existing embed block (or inline reference) with a new target
- **THEN** the link's `pageId` is updated to the new target's id

#### Scenario: Inline reference removal

- **WHEN** `remove_link` targets an inline reference in a given block
- **THEN** the matching `{ reference }` delta is removed from that block's `Y.Text`

### Requirement: Create a new doc and link to it in one step

The system SHALL support a `create_doc_and_link` op that creates a new doc (registering it in the workspace root doc) and inserts a link to it from the source doc.

#### Scenario: Spin off a linked page

- **WHEN** `create_doc_and_link` is called with a new doc title and a source `doc_id`
- **THEN** a new doc is created and registered in `meta.pages`
- **AND** a link (embed block by default) to the new doc is added to the source doc
- **AND** the tool returns the new doc id and the created link's block id
