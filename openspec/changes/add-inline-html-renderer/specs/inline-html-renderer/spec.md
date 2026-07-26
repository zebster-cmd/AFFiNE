## ADDED Requirements

### Requirement: Local, self-contained rendering

The renderer SHALL display model-generated HTML artifacts using only local browser resources, with no dependency on any external origin or remotely hosted container page. It SHALL NOT load `https://affine.run/static/container.html` or any other network URL to display an artifact, and SHALL NOT depend on cross-window `postMessage` to a foreign origin to deliver the artifact HTML.

#### Scenario: Renders with no network access

- **WHEN** an HTML artifact is previewed while the browser has no network connectivity (offline, or a self-hosted deployment that cannot reach affine.run)
- **THEN** the artifact renders fully and interactively
- **AND** no request is made to `affine.run` or any external host to render it

#### Scenario: Artifact HTML delivered locally

- **WHEN** the renderer mounts an artifact
- **THEN** the artifact HTML is provided to the iframe via a local mechanism (`srcdoc` or an in-page `blob:`/`data:` document), not by navigating the iframe to a remote `src`

### Requirement: Interactive execution in an isolated sandbox

The renderer SHALL execute the artifact's scripts and forms inside a sandboxed iframe whose origin is opaque to the host application. The sandbox SHALL grant `allow-scripts` and form/interaction permissions, and SHALL NOT grant `allow-same-origin`, so the artifact cannot access the host application's DOM, storage, cookies, or authentication state.

#### Scenario: Scripts run

- **WHEN** an artifact contains a `<script>` that mutates its own DOM (e.g. a counter button, a canvas animation)
- **THEN** the script executes and the artifact behaves interactively within the preview

#### Scenario: Forms and input work

- **WHEN** an artifact contains form controls (text inputs, buttons, selects)
- **THEN** the user can type into, focus, and submit them within the sandbox

#### Scenario: Host isolation is preserved

- **WHEN** an artifact script attempts to read `window.parent`, the host's `localStorage`/`cookie`, or the host DOM
- **THEN** the access is blocked by the opaque cross-origin sandbox and the host application state is unaffected

### Requirement: Content-aware sizing

The renderer SHALL size the preview to the artifact's content rather than a fixed height. Because the frame is cross-origin, height SHALL be reported by an in-frame host bootstrap over `postMessage`, and the host SHALL NOT attempt direct DOM measurement of the frame. The renderer SHALL apply a sensible maximum height and provide an expand/fullscreen affordance for taller content.

#### Scenario: Short content is not over-tall

- **WHEN** an artifact's rendered content is shorter than the previous fixed height
- **THEN** the iframe shrinks to fit the content

#### Scenario: Content growth is tracked

- **WHEN** an artifact's content height changes after load (e.g. script reveals more content)
- **THEN** the in-frame bootstrap reports the new height and the host resizes the iframe accordingly

#### Scenario: Very tall content is bounded

- **WHEN** an artifact's content exceeds the configured maximum preview height
- **THEN** the iframe is capped at the maximum and the artifact remains scrollable, with an expand/fullscreen control available

### Requirement: State persistence across host re-renders

The renderer SHALL preserve a rendered artifact's live runtime state across host-driven re-renders that do not change the artifact HTML — including toggling between Preview and Code views and chat message list re-renders — by keeping the same iframe instance rather than reloading it.

#### Scenario: Toggling Code/Preview keeps state

- **WHEN** the user interacts with an artifact (e.g. increments a counter), switches to the Code view, then switches back to Preview
- **THEN** the artifact's runtime state is retained (the counter shows its prior value) and the iframe is not reloaded

#### Scenario: Message re-render does not reset the artifact

- **WHEN** the surrounding chat message re-renders while the artifact HTML is unchanged
- **THEN** the iframe is not reloaded and the artifact's runtime state is preserved

#### Scenario: Changed HTML reloads

- **WHEN** the artifact HTML content itself changes
- **THEN** the renderer reloads the frame with the new content

### Requirement: Graceful failure

The renderer SHALL surface a clear, local error state when an artifact cannot be rendered, and SHALL NOT present a fallback that instructs the user to install another application solely because a remote container was unreachable.

#### Scenario: Malformed artifact

- **WHEN** the artifact HTML is empty or cannot be wrapped/rendered
- **THEN** the renderer shows a local error/empty state rather than a blank frame or a crash

#### Scenario: No remote-dependency fallback

- **WHEN** the browser lacks network access
- **THEN** the renderer does not show a "feature not supported / download the Desktop App" message attributable to a missing remote container, because rendering no longer depends on one
