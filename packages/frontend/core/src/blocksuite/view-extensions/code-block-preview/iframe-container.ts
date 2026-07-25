import { wrapArtifactHtml } from './host-bootstrap';

/**
 * Sandbox flags for artifact previews.
 *
 * `allow-same-origin` is deliberately absent. Without it the frame gets a unique
 * opaque origin, so artifact scripts run but cannot reach the host document,
 * storage, cookies, or auth state. Adding it back would collapse the isolation
 * boundary, since frame and embedder would share an origin.
 */
export const ARTIFACT_SANDBOX = [
  'allow-scripts',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-downloads',
  'allow-pointer-lock',
] as const;

/**
 * Render artifact HTML into an iframe entirely locally.
 *
 * The document is delivered via `srcdoc`, so rendering needs no network and no
 * remote container origin.
 */
export function linkIframe(iframe: HTMLIFrameElement, html: string) {
  iframe.removeAttribute('src');

  iframe.sandbox.value = '';
  iframe.sandbox.add(...ARTIFACT_SANDBOX);

  iframe.srcdoc = wrapArtifactHtml(html);
}
