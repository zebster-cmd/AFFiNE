## ADDED Requirements

### Requirement: Inline reasoning tags are separated from content

The system SHALL detect reasoning delivered inline as `<think>…</think>` segments within the assistant content stream and route that reasoning onto the reasoning channel, excluding it from assistant content. This SHALL apply to both the streaming text path and the streaming object path.

#### Scenario: Inline think block in a streamed text response

- **WHEN** a provider (e.g. GLM via Requesty) streams content containing `<think>my reasoning</think>visible answer`
- **THEN** `my reasoning` is emitted on the reasoning channel (as `reasoning-delta`)
- **AND** only `visible answer` is emitted as content
- **AND** the accumulated content string contains no `<think>` or `</think>` markers and no reasoning text

#### Scenario: Think block split across multiple stream chunks

- **WHEN** the `<think>` open tag, reasoning body, and `</think>` close tag arrive in separate stream chunks
- **THEN** the reasoning body is still routed to the reasoning channel in full
- **AND** no partial tag fragment leaks into content

#### Scenario: Content without think tags is unchanged

- **WHEN** a provider streams content that contains no `<think>` tags
- **THEN** all content is emitted unchanged as content
- **AND** no reasoning-delta is produced from the content

### Requirement: Tool and artifact text excludes reasoning

The system SHALL exclude reasoning parts from the text returned to tool-driven, non-streaming prompt executions, so that generated artifacts contain only content.

#### Scenario: Code artifact from a reasoning model

- **WHEN** a `code_artifact` prompt is executed against a model whose response includes reasoning (either separated natively or inline `<think>` tags)
- **THEN** the returned artifact HTML contains no reasoning text and no `<think>`/`</think>` markers

#### Scenario: Non-streaming text extraction drops reasoning parts

- **WHEN** `extractTextResponse` processes a message whose `content` parts include both `text` and `reasoning` parts
- **THEN** only `text` parts are concatenated into the returned string
- **AND** `reasoning` parts are omitted

#### Scenario: Accumulated text() skips reasoning chunks

- **WHEN** `adapter.text()` accumulates a stream that yields both text-delta and reasoning-delta chunks
- **THEN** the returned string contains only the text-delta content
- **AND** reasoning-delta content is omitted

### Requirement: Reasoning remains available on its own channel

The system SHALL continue to surface reasoning on the reasoning channel for display purposes; separation MUST NOT discard reasoning entirely.

#### Scenario: Reasoning still emitted for display

- **WHEN** a response contains reasoning (native or inline)
- **THEN** the reasoning is available as reasoning-delta / `{ type: 'reasoning' }` events for the UI to render (e.g. as a callout)
- **AND** it is not present in the content channel
