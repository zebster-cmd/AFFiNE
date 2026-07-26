## Context

HTML artifact previews are rendered by `HTMLPreview` (`code-block-preview/html-preview.ts`), which delegates to `linkIframe` (`code-block-preview/iframe-container.ts`). Today `linkIframe`:

1. Points the iframe at `https://affine.run/static/container.html`.
2. Adds a permissive sandbox including both `allow-scripts` **and** `allow-same-origin`.
3. On `onload`, posts the artifact HTML to the remote container via `contentWindow.postMessage(html, 'https://affine.run')`.

The remote page is the isolation boundary: it runs on the `affine.run` origin, so artifact scripts execute cross-origin to the host app. The cost is a hard runtime dependency on affine.run for something that is otherwise a purely local render. This renderer is shared by two call sites — the chat code-artifact preview (`ai-tools/code-artifact.ts` → `<affine-html-preview>`) and inserted `affine:code` blocks with `preview: true` in docs (`CodeBlockHtmlPreview` extension) — so both benefit from a local replacement.

The only existing local path (`adapter-panel/.../adapter-panel-body.ts`) uses `<iframe srcdoc sandbox="allow-same-origin">`, which cannot run scripts and is therefore not interactive.

Constraints: artifact HTML is untrusted (model-generated). The host app holds auth tokens and workspace data in its origin. The renderer runs in both web and Electron desktop builds.

## Goals / Non-Goals

**Goals:**

- Render artifacts with zero dependency on a remote container origin (works offline / self-hosted).
- Preserve interactivity: scripts, forms, input, pointer.
- Isolate the artifact from the host origin at least as strongly as the current remote flow.
- Size the preview to content instead of a fixed 544px, with a bounded max and an expand affordance.
- Preserve artifact runtime state across host re-renders that don't change the HTML.

**Non-Goals:**

- Changing the `code_artifact` server tool or its `{ title, html, size }` result contract.
- Guaranteeing that artifacts which fetch their _own_ external resources (CDN scripts, remote fonts) work offline — that depends on the artifact, not the container. Only the _container_ dependency is removed.
- Migrating `adapter-panel-body.ts` to the new renderer (possible follow-up).
- Persisting artifact state across full page reloads or serializing it to storage.

## Decisions

### 1. Deliver HTML via `srcdoc`, not a remote `src`

Set `iframe.srcdoc = wrappedHtml` and remove the remote `src` navigation and the cross-window `postMessage` handshake. `srcdoc` needs no URL lifecycle management (unlike `blob:`), keeps everything in-page, and — combined with the sandbox below — yields an opaque origin.

_Alternatives:_ `blob:`/`data:` URL (also opaque under sandbox, but adds object-URL lifecycle and, for `data:`, size/encoding overhead). Keeping the remote container (rejected: the whole point is to drop it).

### 2. Sandbox with an opaque origin — `allow-scripts` **without** `allow-same-origin`

Sandbox flags: `allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock`. Deliberately **omit `allow-same-origin`**.

Without `allow-same-origin` a sandboxed frame gets a unique opaque origin: scripts run, but the frame is cross-origin to the host, so it cannot touch the host DOM, and `localStorage`/`sessionStorage`/`document.cookie` resolve to the guest's own opaque (empty) origin — it cannot read host storage or auth. This is strictly _more_ isolated than today's `allow-same-origin` remote flow. (The browser also refuses to treat `allow-scripts allow-same-origin` as sandboxed when frame and embedder share an origin, which is exactly the escape we avoid by dropping the flag.)

_Trade-off:_ guest `localStorage` throws / is unavailable — acceptable for one-shot artifacts, and matches what a foreign-origin container already implied.

### 3. Host bootstrap injected into the wrapped document (sizing + handshake over `postMessage`)

Because the frame is cross-origin, the host cannot measure it directly. A small bootstrap script is injected into the artifact HTML (before `</body>`, with a head/append fallback) that:

- observes document height via `ResizeObserver` on `documentElement`/`body`,
- posts `{ source: 'affine-artifact', type: 'resize', height }` to `parent` with target origin `'*'` (guest is opaque, so it cannot know the parent origin), and
- posts a `ready` message on load and an `error` message from `window.onerror`.

The host (`HTMLPreview`) listens for `message`, and **validates `event.source === this.iframe.contentWindow`** (the security check that replaces origin checking for an opaque frame), then sets the iframe height clamped to `[min, maxHeight]`. Direct DOM measurement of the frame is never attempted.

Injection wraps rather than replaces the artifact's own document so model output (`<!DOCTYPE html>…</html>` from `preprocessHtml`) renders unchanged.

### 4. Content-aware height, but only where it applies

**Discovered during implementation:** `affine-html-preview` has two call sites with different sizing contracts.

1. **Chat code-artifact** renders inside `artifacts-preview-panel` — a full-size panel (`position: absolute`, `height: calc(100% - 52px)`). `code-artifact.ts` deliberately stretches `.html-preview-iframe` to `height: 100%` to fill it, so the hard-coded `544px` is already overridden there.
2. **Doc `affine:code` block** with `preview: true` renders inline in document flow. This is where `544px` is actually live and where content-aware sizing is the real win.

Naively setting an inline `height` would be a regression: inline styles beat stylesheet rules, so it would override the panel's `height: 100%` and break the chat layout.

**Decision:** `HTMLPreview` gains an `autoResize` property, defaulting to `true`. Doc code blocks auto-size to content, clamped to `[ARTIFACT_MIN_HEIGHT, ARTIFACT_MAX_HEIGHT]` with internal scrolling beyond the max. `code-artifact.ts` passes `.autoResize=${false}` so the panel keeps filling exactly as today. Resize messages are still parsed in both modes; only the height application is gated.

**Max height / expand:** clamp at `640px`. No new expand control is built — the chat path already has the full preview panel and doc code blocks have their own block affordances, so a second competing control would be redundant. (This retires task 4.4.)

### 5. Persist state by keeping the iframe instance stable

Two mechanisms:

- **Guard reloads:** `HTMLPreview` reloads (`linkIframe`) only when the normalized HTML actually changes — track the last-rendered string and skip `_link()` on unrelated `updated()` calls.
- **Keep the element mounted:** in `code-artifact.ts`, toggling Code⇄Preview keeps the `<affine-html-preview>` element in the DOM (hidden, not removed) so the iframe — and its runtime state — survives. Key the preview by `toolCallId` so chat message re-renders reuse the same element instead of recreating it.

## Risks / Trade-offs

- **Content-Security-Policy blocks `srcdoc` scripts** → Verify the app CSP (`frame-src`, `sandbox`, `script-src`) permits sandboxed `srcdoc` frames with scripts in both web and Electron (`webPreferences`/`webview`). If blocked, add the minimal directive; capture in Open Questions before implementation lands.
- **Guest storage APIs throw under opaque origin** → Document as expected; artifacts relying on `localStorage` degrade, not crash. The injected bootstrap must not itself use storage.
- **`postMessage` spoofing** → Host accepts resize/ready/error only when `event.source` matches the specific iframe `contentWindow` and the payload carries the `affine-artifact` marker; height is clamped, so a hostile value cannot blow up layout.
- **Loss of a real reason for the remote container** → If affine.run's container.html provided behavior beyond isolation (e.g. shared polyfills), confirm before removal. Current code shows only postMessage-render, so none is assumed.
- **Two call sites** (chat preview + inserted doc code blocks) share `affine-html-preview` → verify both after the change; the doc-block path has no toggle but must still size and isolate correctly.

## Migration Plan

- Change is internal to the renderer; the `code_artifact` contract and both call sites' public shape are unchanged. Deploy is a straight replacement of `linkIframe`/`HTMLPreview` internals.
- **Rollback:** revert the frontend commit — restores the remote-container behavior with no data migration.
- Optionally gate behind a feature flag during rollout to A/B the local renderer against the remote container; not required given the clean revert path.

## Open Questions

- ~~Exact `maxHeight` for the bounded preview, and whether expand opens a fullscreen modal or an in-place expansion.~~ **Resolved:** `640px` max; no new expand affordance (see Decision 4).
- ~~Does the current app CSP already permit sandboxed `srcdoc` script execution in web **and** Electron, or is a directive change needed?~~ **Resolved:** yes, no change needed — no `script-src`/`frame-src` policy exists on the host document in either build; Electron only sets `frame-ancestors`, which does not apply to `srcdoc` children. Recorded in tasks 1.1/1.2.
- Should this change also retire the browser "not supported / download the Desktop App" fallback entirely, or keep it for unrelated failure modes?
- Should `adapter-panel-body.ts`'s script-less `srcdoc` path be migrated in this change or a follow-up? (Currently Non-Goal.)
