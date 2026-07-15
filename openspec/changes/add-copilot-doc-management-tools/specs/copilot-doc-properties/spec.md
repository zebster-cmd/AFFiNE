## ADDED Requirements

### Requirement: Read a doc's attributes

The system SHALL provide a `doc_properties_read` tool that returns an aggregated view of a doc's attributes, resolving ids to human-readable names. It SHALL require `Doc.Read` permission and be ungated.

#### Scenario: Read aggregates all zones

- **WHEN** `doc_properties_read` is called with a `doc_id` the caller can read
- **THEN** it returns the doc's title, trash state, favorite state (for the acting user), tags (each with resolved name and color), custom properties (each with resolved name, type, and value), journal date, and primary mode

#### Scenario: Doc not found or not readable

- **WHEN** the `doc_id` does not exist or the caller lacks `Doc.Read`
- **THEN** the tool returns a structured `toolError` naming the doc id, and does not throw a raw error

### Requirement: Update a doc's attributes in one transaction

The system SHALL provide a `doc_properties_update` tool that applies a batch of operations to a doc's attributes in a single CRDT transaction. It SHALL require `Doc.Update` permission and be gated behind `env.dev || env.namespaces.canary`. Supported ops: `set_title`, `set_trash`, `set_journal`, `set_mode`, `set_favorite`, `add_tag`, `remove_tag`, `create_tag`, `set_property`, `define_property`. Writes SHALL use the delta-against-state-vector push pattern; a batch MUST apply fully or not at all.

#### Scenario: Batched core metadata update

- **WHEN** `doc_properties_update` is called with ops `set_title`, `set_trash`, `set_journal`, `set_mode`
- **THEN** the title, trash flag, journal date (`YYYY-MM-DD`), and primary mode (`page`|`edgeless`) are updated in one transaction
- **AND** the tool returns a success summary with the count of applied ops

#### Scenario: Mid-batch failure aborts the whole batch

- **WHEN** any op in the batch is invalid (e.g. an unknown id or a type mismatch)
- **THEN** no ops are persisted (no partial write)
- **AND** the tool returns a `toolError` naming the failing op

### Requirement: Manage tags by name with explicit creation

The system SHALL let the AI add and remove tags on a doc referenced by tag name (with id fallback), and SHALL create new tags only via the explicit `create_tag` op. Tag definitions live in the workspace root doc `meta.properties.tags.options`; a doc's tags are the id list in `meta.pages[].tags`.

#### Scenario: Add an existing tag by name

- **WHEN** `add_tag` is called with the name of an existing tag
- **THEN** that tag's id is added to the doc's tag list

#### Scenario: Add a tag that does not exist

- **WHEN** `add_tag` is called with a name that matches no existing tag
- **THEN** the tool returns a `toolError` instructing the caller to `create_tag` first
- **AND** no tag is silently created

#### Scenario: Ambiguous tag name

- **WHEN** a tag name matches more than one tag definition
- **THEN** the tool returns a `toolError` listing the candidate ids/colors so the caller can disambiguate

#### Scenario: Create a new tag definition

- **WHEN** `create_tag` is called with a name (and optional color)
- **THEN** a new tag option `{ id, value, color }` is added to `meta.properties.tags.options`

### Requirement: Manage custom properties by name with explicit definition

The system SHALL let the AI set custom property values by property name (id fallback) and define new custom properties only via the explicit `define_property` op. Values are persisted as strings under `custom:<propertyId>` in `db$<ws>$docProperties`; definitions live in `db$<ws>$docCustomPropertyInfo`. Supported property types are `text`, `number`, `checkbox`, `date`, `tags`.

#### Scenario: Set an existing property value

- **WHEN** `set_property` is called with an existing property name and a value
- **THEN** the value is written as a string to `custom:<propertyId>` on the doc's row

#### Scenario: Set a value for an undefined property

- **WHEN** `set_property` targets a name that matches no defined property
- **THEN** the tool returns a `toolError` instructing the caller to `define_property` first

#### Scenario: Define a new custom property

- **WHEN** `define_property` is called with a name and a supported type
- **THEN** a definition row `{ id, name, type, show, index }` is created in `docCustomPropertyInfo`

#### Scenario: Unsupported property type

- **WHEN** `define_property` is called with a type outside `text|number|checkbox|date|tags` (e.g. `select`)
- **THEN** the tool returns a `toolError` naming the type and noting that select/multi-select exist only in database blocks

### Requirement: Favorite is scoped to the acting user

The system SHALL treat `set_favorite` as affecting the acting user's favorites only, writing to the per-user userspace favorites doc rather than a global doc flag.

#### Scenario: Favoriting a doc

- **WHEN** `set_favorite` is called with `true`
- **THEN** the doc is marked favorite for the acting user in the userspace favorites doc
- **AND** the behavior is documented as user-scoped, not a global attribute
