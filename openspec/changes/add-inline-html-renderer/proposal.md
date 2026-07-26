## Why

The copilot's HTML artifact preview renders untrusted, model-generated HTML by loading a **remote** page — `https://affine.run/static/container.html` — into an iframe and posting the HTML into it (`iframe-container.ts`). The remote page is the security isolation boundary: it runs the artifact's scripts on a foreign origin so they can't touch the host app. This couples every preview to affine.run being reachable: a self-hosted / requesty-fork deployment, an offline desktop session, or any network hiccup produces a blank or fallback ("download the Desktop App") preview. The only fully-local alternative in the codebase (`adapter-panel-body.ts`) uses `srcdoc` with `sandbox="allow-same-origin"` and therefore **cannot run scripts** — so it is not interactive. We want an interactive HTML renderer that needs no remote container.

## What Changes

- **Replace the remote container with a self-contained inline renderer.** `linkIframe` stops pointing the iframe at `https://affine.run/static/container.html` and instead renders the artifact HTML locally via `srcdoc` (host-wrapped document), with **no** dependency on any external origin.
- **Keep it interactive while isolated.** The sandbox uses `allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock` but deliberately **omits `allow-same-origin`**, giving the frame an opaque origin. Scripts and forms run, but the artifact cannot read the host app's DOM, storage, cookies, or auth tokens. This is a **security tightening** relative to the current remote flow's `allow-same-origin`.
- **Content-aware sizing.** A tiny host bootstrap injected into the wrapped document measures content height (`ResizeObserver`) and posts it to the parent, which sizes the iframe to content (with a sane max + expand/fullscreen affordance) instead of the fixed 544px. Because the frame is cross-origin, all sizing goes over `postMessage`, never direct DOM measurement.
- **State persistence across re-renders.** The rendered iframe is cached/keyed by artifact identity so toggling Code⇄Preview, or the chat message re-rendering, does not reload the frame and discard the artifact's runtime state.
- **Removed dependency:** the hard runtime coupling to `affine.run/static/container.html`. Renderer now works offline, self-hosted, and in the desktop app uniformly; the browser "not supported / download Desktop App" fallback path is no longer needed for this reason.

## Capabilities

### New Capabilities

- `inline-html-renderer`: Model-generated HTML artifacts render in a fully local, self-contained sandboxed iframe (no remote container origin) that executes scripts and forms in an isolated opaque origin, sizes itself to its content, and preserves its runtime state across host re-renders.

### Modified Capabilities

<!-- None: there are no existing specs under openspec/specs/. The current renderer has no spec of record. -->

## Impact

- **Code (frontend only):**
  - `packages/frontend/core/src/blocksuite/view-extensions/code-block-preview/iframe-container.ts` — `linkIframe` rewritten: build the host-wrapped `srcdoc`, set the isolated sandbox, drop the remote `src` + cross-window `postMessage(html, 'https://affine.run')` handshake.
  - `packages/frontend/core/src/blocksuite/view-extensions/code-block-preview/html-preview.ts` — `HTMLPreview`: content-aware height (replace fixed `544px`), `postMessage` height listener, state/`error`/`fallback` handling; keep the iframe element stable across `updated`.
  - `packages/frontend/core/src/blocksuite/ai/components/ai-tools/code-artifact.ts` — preview caching keyed by artifact id so Code⇄Preview toggling and message re-render don't reload; sizing hooks.
  - A new host bootstrap/wrapper module (e.g. `code-block-preview/host-bootstrap.ts`) producing the injected sizing/state script and the wrapped document.
- **Security / policy:** guest runs on an opaque origin (no `allow-same-origin`). Confirm the app **Content-Security-Policy** (`frame-src`, `sandbox` directives) permits `srcdoc` frames with scripts in both web and Electron; document any CSP adjustment needed.
- **No changes** to the copilot server, native crates, or the `code_artifact` tool contract (`{ title, html, size }` is unchanged).
- **Reuse:** the same local renderer can replace the script-less `srcdoc` path in `adapter-panel-body.ts` (optional follow-up, out of scope here).
- **Tests:** frontend unit/integration for `linkIframe` wrapping + sandbox flags and the sizing/persistence behavior; manual verification of an interactive artifact (script + form) rendering offline.
