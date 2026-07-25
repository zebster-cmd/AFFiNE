/**
 * Marker carried by every message the artifact guest posts to the host.
 *
 * The guest runs on an opaque origin (the sandbox deliberately omits
 * `allow-same-origin`), so it cannot know the host origin and must post with a
 * wildcard target. The host therefore authenticates messages by checking
 * `event.source === iframe.contentWindow` and matching this marker, rather than
 * by origin.
 */
export const ARTIFACT_MESSAGE_SOURCE = 'affine-artifact';

export type ArtifactMessage =
  | { source: typeof ARTIFACT_MESSAGE_SOURCE; type: 'ready' }
  | { source: typeof ARTIFACT_MESSAGE_SOURCE; type: 'resize'; height: number }
  | { source: typeof ARTIFACT_MESSAGE_SOURCE; type: 'error'; message: string };

/** Smallest height an auto-sized preview may collapse to. */
export const ARTIFACT_MIN_HEIGHT = 120;

/** Tallest an auto-sized preview grows before it scrolls internally. */
export const ARTIFACT_MAX_HEIGHT = 640;

/**
 * Validate an incoming `message` payload as an artifact protocol message.
 *
 * Returns `null` for anything unrecognised. Callers MUST additionally verify
 * `event.source === iframe.contentWindow` before trusting the result — the
 * marker alone is guessable, and the opaque guest origin makes origin checks
 * useless.
 */
export function parseArtifactMessage(data: unknown): ArtifactMessage | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }

  const raw = data as Record<string, unknown>;
  if (raw.source !== ARTIFACT_MESSAGE_SOURCE) return null;

  switch (raw.type) {
    case 'ready':
      return { source: ARTIFACT_MESSAGE_SOURCE, type: 'ready' };

    case 'resize': {
      const { height } = raw;
      if (
        typeof height !== 'number' ||
        !Number.isFinite(height) ||
        height <= 0
      ) {
        return null;
      }
      return { source: ARTIFACT_MESSAGE_SOURCE, type: 'resize', height };
    }

    case 'error':
      return {
        source: ARTIFACT_MESSAGE_SOURCE,
        type: 'error',
        message:
          typeof raw.message === 'string' && raw.message
            ? raw.message
            : 'Unknown error',
      };

    default:
      return null;
  }
}

/**
 * Bound a guest-reported height. The guest is untrusted, so a hostile or buggy
 * value can never blow up host layout.
 */
export function clampArtifactHeight(height: number): number {
  if (!Number.isFinite(height)) return ARTIFACT_MIN_HEIGHT;
  return Math.min(ARTIFACT_MAX_HEIGHT, Math.max(ARTIFACT_MIN_HEIGHT, height));
}

/**
 * Whether the frame needs to be (re)loaded.
 *
 * `skip` is what preserves a running artifact's state: the host re-renders for
 * unrelated reasons (view toggles, chat message updates), and reloading the
 * frame on those would reset the artifact.
 */
export type LinkDecision = 'empty' | 'skip' | 'link';

export function decideLink(
  next: string | null | undefined,
  rendered: string | null,
  isShowing: boolean
): LinkDecision {
  if (!next) return 'empty';
  if (next === rendered && isShowing) return 'skip';
  return 'link';
}

/** What the host should do in response to an incoming `message` event. */
export type GuestMessageAction =
  | { kind: 'ignore' }
  | { kind: 'resize'; height: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const IGNORE: GuestMessageAction = { kind: 'ignore' };

/**
 * Decide how to handle a `message` event that may have come from an artifact.
 *
 * Authentication is by window handle: only the frame we rendered can be
 * `event.source`. Origin is useless here because the guest is on an opaque
 * origin and must post with a wildcard target, and the marker alone is
 * guessable by any other frame on the page.
 */
export function resolveGuestMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
  options: { autoResize: boolean }
): GuestMessageAction {
  if (!frame || !event.source || event.source !== frame.contentWindow) {
    return IGNORE;
  }

  const message = parseArtifactMessage(event.data);
  if (!message) return IGNORE;

  switch (message.type) {
    case 'resize':
      if (!options.autoResize) return IGNORE;
      return { kind: 'resize', height: clampArtifactHeight(message.height) };

    case 'ready':
      return { kind: 'ready' };

    case 'error':
      return { kind: 'error', message: message.message };
  }
}

/**
 * Script injected into the artifact document. It reports content height,
 * readiness, and runtime errors to the host.
 *
 * Deliberately avoids storage APIs: under an opaque origin `localStorage` and
 * friends either throw or resolve to a throwaway store, so touching them would
 * only create noise.
 */
// The closing tag is split so this module stays safe to inline into an HTML
// <script> block, where a literal `</script>` would terminate it early.
const BOOTSTRAP = `<script>
(function () {
  var SOURCE = '${ARTIFACT_MESSAGE_SOURCE}';
  var lastHeight = -1;

  function post(type, height, message) {
    var payload = { source: SOURCE, type: type };
    if (typeof height === 'number') payload.height = height;
    if (message) payload.message = message;
    try {
      parent.postMessage(payload, '*');
    } catch (e) {
      /* host went away */
    }
  }

  function measure() {
    var doc = document.documentElement;
    var body = document.body;
    var height = Math.max(
      doc ? doc.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      post('resize', height);
    }
  }

  window.addEventListener('error', function (event) {
    var text = event && event.message ? String(event.message) : 'Unknown error';
    post('error', undefined, text);
  });

  if (typeof ResizeObserver !== 'undefined') {
    var observer = new ResizeObserver(measure);
    if (document.documentElement) observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }

  window.addEventListener('load', function () {
    measure();
    post('ready');
  });

  measure();
})();
${'</'}script>`;

/**
 * Wrap untrusted artifact HTML with the host bootstrap, without disturbing the
 * artifact's own markup.
 *
 * Injects before the last `</body>`, falling back to the last `</html>`, then to
 * a plain append for bare fragments. The *last* closing tag is used so prose or
 * escaped markup mentioning `</body>` cannot displace the bootstrap.
 */
export function wrapArtifactHtml(html: string): string {
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + BOOTSTRAP + html.slice(bodyClose);
  }

  const htmlClose = html.lastIndexOf('</html>');
  if (htmlClose !== -1) {
    return html.slice(0, htmlClose) + BOOTSTRAP + html.slice(htmlClose);
  }

  return html + BOOTSTRAP;
}
