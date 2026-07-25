## 1. Verify constraints before coding

- [x] 1.1 Confirm the app Content-Security-Policy permits sandboxed `srcdoc` frames with script execution in the **web** build (`frame-src`/`script-src`/`sandbox`); note any directive change needed.
  - **Finding: no change needed.** No `script-src`/`frame-src` CSP is applied to the app document — no `<meta http-equiv>` in any frontend HTML template, and no helmet/CSP middleware in the backend server. A `srcdoc` iframe _inherits the embedder's_ CSP; with no restrictive host policy the inherited policy is empty, so sandboxed `srcdoc` scripts execute.
  - **Risk recorded:** if a `script-src` CSP is ever introduced on the host document, `srcdoc` artifacts inherit it and would break. A future strict CSP must add an explicit allowance for the artifact frame.
- [x] 1.2 Confirm the same in the **Electron desktop** build (`webPreferences` / `<webview>` sandbox); note any change needed.
  - **Finding: no change needed.** The only CSP Electron sets is `frame-ancestors`, via `ensureFrameAncestors` in `packages/frontend/apps/electron/src/main/protocol.ts:176`. `frame-ancestors` governs who may embed _us_, not what we may embed, and does not apply to `srcdoc` children. Renderer `webPreferences` (`sandbox: true, contextIsolation: true, nodeIntegration: false` — `web-preferences.ts:7`) constrain the renderer process, not child-iframe capability. No `webviewTag` usage anywhere; we use a plain `<iframe>`.
- [x] 1.3 Confirm affine.run's `container.html` provides only postMessage-render (no shared polyfills/behavior we must replicate); record the finding.
  - **Finding: confirmed — nothing to replicate.** Fetched (HTTP 200, 773 bytes). The entire page is one inline script: `window.addEventListener('message', …)` → if `event.data` is a string, `document.open(); document.write(event.data); document.close();` then removes the listener. No polyfills, no stylesheets, no APIs exposed to the artifact.
  - **Notes that shape the implementation:** (a) it performs **no origin check** on the incoming message, so the local replacement is strictly more defensive; (b) it never posts anything _back_, so there is no existing ready/error/resize handshake — which is why height is hard-coded to `544px` and why `html-preview.ts` optimistically sets `state = 'finish'` as soon as `linkIframe` returns rather than on real render success.

## 2. Host bootstrap + wrapper

- [x] 2.1 Add `code-block-preview/host-bootstrap.ts`: a function that injects the sizing/handshake script into artifact HTML (before `</body>`, with head/append fallback) and returns the wrapped document.
  - `wrapArtifactHtml()` injects before the **last** `</body>`, falling back to the last `</html>`, then a plain append. Using the last closing tag means prose or escaped markup mentioning `</body>` cannot displace the bootstrap (covered by a decoy test).
- [x] 2.2 Bootstrap script: `ResizeObserver` on `documentElement`/`body` → `parent.postMessage({ source: 'affine-artifact', type: 'resize', height }, '*')`; emit `ready` on load and `error` from `window.onerror`. Must not use storage APIs.
  - Also de-duplicates: only posts `resize` when the measured height actually changes.

## 3. Rewrite `linkIframe` (iframe-container.ts)

- [x] 3.1 Remove the remote `src = 'https://affine.run/static/container.html'` navigation and the `onload` cross-window `postMessage(html, 'https://affine.run')` handshake.
  - Confirmed empirically: before the change the happy-dom test run attempted real network fetches of `https://affine.run/static/container.html`; after the change that noise is gone.
- [x] 3.2 Set `iframe.srcdoc` to the wrapped document from the host bootstrap.
- [x] 3.3 Set sandbox to `allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock` — **omit `allow-same-origin`**.
  - `sandbox.value` is reset before adding flags so a re-link cannot inherit a stale `allow-same-origin`; a regression test asserts this across re-links.

## 4. `HTMLPreview` (html-preview.ts)

- [x] 4.1 Replace fixed `544px` height with content-driven height clamped to `[min, maxHeight]`; internal scroll beyond max.
  - **Scoped by discovery:** gated behind a new `autoResize` property (default `true`). See design Decision 4 — the chat preview panel intentionally stretches the frame to `height: 100%`, and an inline height would override that stylesheet rule and break the panel. `code-artifact.ts` passes `.autoResize=${false}`.
  - The `544px` CSS default is kept as the pre-measurement value, so a preview whose bootstrap never runs degrades to exactly today's behavior instead of collapsing.
- [x] 4.2 Add a `message` listener that accepts `resize`/`ready`/`error` only when `event.source === this.iframe.contentWindow` and the `affine-artifact` marker is present; clamp height; drive `loading`/`finish`/`error` state from the handshake.
  - Decision logic extracted to a pure `resolveGuestMessage(event, frame, { autoResize })` so it is testable (see 6.2).
  - **Deviation, deliberate:** a guest `error` does **not** flip the preview to the error state. Model-generated artifacts commonly throw benign script errors (e.g. a missing CDN asset) while still rendering; hiding the render would be a regression. Guest errors are logged instead. The `error` state remains for `linkIframe` failure.
  - **Deviation, deliberate:** the frame is revealed on link rather than waiting for `ready`. If the bootstrap never runs (blocked script, exotic artifact), waiting would hide the artifact forever. `ready` still confirms the state.
- [x] 4.3 Guard reloads: track the last-rendered normalized HTML and call `_link()` only when it actually changes (skip unrelated `updated()` calls).
  - Extracted to a pure `decideLink(next, rendered, isShowing)` returning `empty | skip | link`.
- [x] ~~4.4 Add an expand/fullscreen affordance for content beyond `maxHeight`.~~ **Retired by decision** (design Decision 4): the chat path already has the full preview panel and doc code blocks have their own affordances, so a second competing control would be redundant. Content beyond `640px` scrolls internally.
- [x] 4.5 Remove/relax the remote-container "not supported / download Desktop App" fallback that was attributable to an unreachable container (keep only for genuine unsupported cases, if any).
  - The `fallback` state now only fires for empty HTML, so its copy became the neutral empty state "Nothing to preview yet."

## 5. Code-artifact preview persistence (code-artifact.ts)

- [x] 5.1 Key the `<affine-html-preview>` by `toolCallId` so chat message re-renders reuse the same element.
  - Uses lit's `keyed()` directive. Verified the panel path re-renders through lit diffing (`renderPreviewPanel` → `ArtifactPreviewPanel.content` is a reactive `TemplateResult`), so a stable template + stable key preserves the DOM.
- [x] 5.2 On Code⇄Preview toggle, keep the preview element mounted (hide, don't remove) so the iframe and its runtime state survive.
  - **Root cause of state loss identified:** the old code used a ternary that swapped between two _different_ templates, which guaranteed lit tore down the iframe on every toggle. Both views are now always rendered and toggled with the `hidden` attribute.

## 6. Tests

- [x] 6.1 Unit-test the wrapper/bootstrap injection and that `linkIframe` sets `srcdoc` + the exact sandbox flags and never a remote `src`.
  - `__tests__/host-bootstrap.spec.ts` (wrapping, injection points, decoy `</body>`, no storage APIs, script integrity) and `__tests__/iframe-container.spec.ts` (srcdoc, no remote `src`, exact sandbox flags, re-link safety).
  - Added a **script-integrity** guard: the injected bootstrap is extracted and parsed, because a syntax error there would silently break sizing for every artifact. Mutation-checked — it fails on an injected syntax error.
- [x] 6.2 Test the host `message` handler: source validation, marker check, height clamping, state transitions.
  - `__tests__/guest-message.spec.ts` covers `resolveGuestMessage` against **real iframes**: accepts own frame, rejects another frame / the host window / a missing source / a marker-less payload, clamps to min and max, gates resize on `autoResize`, and passes `ready` through regardless.
  - Source validation was **mutation-checked**: removing the `event.source` comparison fails exactly the three spoofing tests.
- [x] 6.3 Test reload-guard: unchanged HTML does not reload; changed HTML does.
  - `decideLink` covered in `guest-message.spec.ts` (`empty` / `skip` / `link`, including identical HTML that is not currently showing).
- [x] 6.4 Manual/integration: an interactive artifact (script counter + a form) renders and stays interactive **offline**; state persists across Code⇄Preview toggle; host storage/DOM is inaccessible from the guest.
  - **Automated in real Chromium** — `__tests__/artifact-sandbox.integration.spec.ts` (15 tests), following the repo's existing integration-spec pattern (local http server + `chromium.launch()`); Playwright's Chromium binary was installed. The spec imports `wrapArtifactHtml` and `ARTIFACT_SANDBOX` from production so it cannot drift from what ships.
  - Verified by the browser, not by assertion about our own code: scripted counter responds to clicks; form input accepts text; **zero network requests** (nothing to `affine.run`); guest posts `resize` + `ready`; `window.origin` is `'null'`; guest cannot read `parent.document`; host `localStorage`/`cookie` do not leak.
  - **Stronger than specified:** Chromium _throws_ `SecurityError` on `document.cookie` in the guest rather than returning empty — the sandbox denies cookie access outright without `allow-same-origin`.
  - State persistence proven both ways: toggling `hidden` preserves the counter value; re-creating the frame resets it to `0` (the old ternary's behaviour, kept as a test so the reason the fix matters stays visible).
  - **The central security claim is proven, not asserted:** a dedicated group renders with `allow-same-origin` added _in the test only_ and shows the guest then **can** reach `parent.document` and loses its opaque origin. Production's list is never modified, and a third test asserts it never contains the flag.
- [x] 6.5 Verify both call sites — chat code-artifact preview and inserted `affine:code` `preview: true` doc block — render, size, and isolate correctly.
  - **Renderer-level: verified.** Both sizing modes are covered — tall content reports a height above the cap (host clamps it, per `clampArtifactHeight` unit tests) and short content reports well under the old fixed `544px`, which is the concrete win for the inline doc-block case.
  - **Remaining gap, stated plainly:** the two call sites are verified at the renderer/mode level, **not** by driving the assembled app (chat panel with a live AI response, and a doc containing an `affine:code preview` block). That needs a running AFFiNE instance with a workspace. Static checks in place instead: typecheck clean, and the panel-stretch CSS path traced to confirm `autoResize=false` prevents the inline-height regression.
