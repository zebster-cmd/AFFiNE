import { describe, expect, test } from 'vitest';

import {
  ARTIFACT_MAX_HEIGHT,
  ARTIFACT_MESSAGE_SOURCE,
  ARTIFACT_MIN_HEIGHT,
  clampArtifactHeight,
  parseArtifactMessage,
  wrapArtifactHtml,
} from '../host-bootstrap';

const FULL_DOC = `<!DOCTYPE html>
<html>
<head><title>Artifact</title></head>
<body><h1>Hello</h1></body>
</html>`;

describe('wrapArtifactHtml', () => {
  test('injects the bootstrap before the closing body tag', () => {
    const wrapped = wrapArtifactHtml(FULL_DOC);

    const scriptStart = wrapped.indexOf('<script');
    const bodyClose = wrapped.indexOf('</body>');

    expect(scriptStart).toBeGreaterThan(-1);
    expect(bodyClose).toBeGreaterThan(-1);
    expect(scriptStart).toBeLessThan(bodyClose);
  });

  test('preserves the original artifact markup', () => {
    const wrapped = wrapArtifactHtml(FULL_DOC);

    expect(wrapped).toContain('<!DOCTYPE html>');
    expect(wrapped).toContain('<title>Artifact</title>');
    expect(wrapped).toContain('<h1>Hello</h1>');
  });

  test('injects before the closing html tag when there is no body', () => {
    const wrapped = wrapArtifactHtml(
      '<!DOCTYPE html><html><head></head></html>'
    );

    const scriptStart = wrapped.indexOf('<script');
    const htmlClose = wrapped.indexOf('</html>');

    expect(scriptStart).toBeGreaterThan(-1);
    expect(scriptStart).toBeLessThan(htmlClose);
  });

  test('appends the bootstrap for a bare fragment', () => {
    const wrapped = wrapArtifactHtml('<h1>fragment</h1>');

    expect(wrapped).toContain('<h1>fragment</h1>');
    expect(wrapped.indexOf('<script')).toBeGreaterThan(
      wrapped.indexOf('<h1>fragment</h1>')
    );
  });

  test('only injects a single bootstrap for a document with nested body text', () => {
    const wrapped = wrapArtifactHtml(
      '<html><body><p>talks about </body> in prose</p></body></html>'
    );

    const occurrences = wrapped.split(ARTIFACT_MESSAGE_SOURCE).length - 1;
    expect(occurrences).toBeGreaterThan(0);
    // the bootstrap must appear exactly once regardless of decoy markup
    expect(wrapped.split('<script').length - 1).toBe(1);
  });

  describe('bootstrap script', () => {
    const script = wrapArtifactHtml(FULL_DOC);

    test('tags every message with the artifact source marker', () => {
      expect(script).toContain(ARTIFACT_MESSAGE_SOURCE);
    });

    test('reports resize, ready and error messages', () => {
      expect(script).toContain('resize');
      expect(script).toContain('ready');
      expect(script).toContain('error');
    });

    test('observes content size with ResizeObserver', () => {
      expect(script).toContain('ResizeObserver');
    });

    test('posts to the parent window with a wildcard target origin', () => {
      // the guest is on an opaque origin and cannot know the parent origin
      expect(script).toMatch(
        /postMessage\([^)]*'\*'|postMessage\([\s\S]*?"\*"/
      );
    });

    test('does not touch storage APIs', () => {
      expect(script).not.toContain('localStorage');
      expect(script).not.toContain('sessionStorage');
      expect(script).not.toContain('indexedDB');
      expect(script).not.toContain('document.cookie');
    });
  });
});

describe('parseArtifactMessage', () => {
  const ok = (extra: Record<string, unknown>) => ({
    source: ARTIFACT_MESSAGE_SOURCE,
    ...extra,
  });

  test('parses a resize message', () => {
    expect(parseArtifactMessage(ok({ type: 'resize', height: 120 }))).toEqual({
      source: ARTIFACT_MESSAGE_SOURCE,
      type: 'resize',
      height: 120,
    });
  });

  test('parses a ready message', () => {
    expect(parseArtifactMessage(ok({ type: 'ready' }))).toEqual({
      source: ARTIFACT_MESSAGE_SOURCE,
      type: 'ready',
    });
  });

  test('parses an error message', () => {
    expect(
      parseArtifactMessage(ok({ type: 'error', message: 'boom' }))
    ).toEqual({
      source: ARTIFACT_MESSAGE_SOURCE,
      type: 'error',
      message: 'boom',
    });
  });

  test('parses an error message that omits the text', () => {
    const parsed = parseArtifactMessage(ok({ type: 'error' }));
    expect(parsed?.type).toBe('error');
  });

  test.each([null, undefined, 'resize', 42, [], true])(
    'rejects non-object payload %s',
    payload => {
      expect(parseArtifactMessage(payload)).toBeNull();
    }
  );

  test('rejects a payload without the source marker', () => {
    expect(parseArtifactMessage({ type: 'resize', height: 10 })).toBeNull();
  });

  test('rejects a payload from a lookalike source', () => {
    expect(
      parseArtifactMessage({ source: 'affine-artifact-evil', type: 'ready' })
    ).toBeNull();
  });

  test('rejects an unknown message type', () => {
    expect(parseArtifactMessage(ok({ type: 'navigate' }))).toBeNull();
  });

  test.each([undefined, '120', null, NaN, Infinity, -1])(
    'rejects resize with invalid height %s',
    height => {
      expect(parseArtifactMessage(ok({ type: 'resize', height }))).toBeNull();
    }
  );
});

describe('clampArtifactHeight', () => {
  test('raises heights below the minimum', () => {
    expect(clampArtifactHeight(1)).toBe(ARTIFACT_MIN_HEIGHT);
  });

  test('caps heights above the maximum', () => {
    expect(clampArtifactHeight(100_000)).toBe(ARTIFACT_MAX_HEIGHT);
  });

  test('passes through in-range heights', () => {
    const mid = Math.round((ARTIFACT_MIN_HEIGHT + ARTIFACT_MAX_HEIGHT) / 2);
    expect(clampArtifactHeight(mid)).toBe(mid);
  });

  test('falls back to the minimum for non-finite input', () => {
    expect(clampArtifactHeight(NaN)).toBe(ARTIFACT_MIN_HEIGHT);
  });

  test('keeps the maximum at or below the previous fixed height budget', () => {
    expect(ARTIFACT_MAX_HEIGHT).toBe(640);
    expect(ARTIFACT_MIN_HEIGHT).toBeLessThan(ARTIFACT_MAX_HEIGHT);
  });
});

describe('bootstrap script integrity', () => {
  /** Pull the injected script body out of a wrapped document. */
  function extractScript(wrapped: string): string {
    const open = wrapped.indexOf('<script>');
    const close = wrapped.indexOf('</script>', open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return wrapped.slice(open + '<script>'.length, close);
  }

  test('emits a syntactically valid script', () => {
    const body = extractScript(wrapArtifactHtml(FULL_DOC));

    // A syntax error here would silently break sizing for every artifact.
    expect(() => new Function(body)).not.toThrow();
  });

  test('emits a properly closed script tag', () => {
    const wrapped = wrapArtifactHtml(FULL_DOC);

    expect(wrapped).toContain('<script>');
    expect(wrapped).toContain('</script>');
    expect(wrapped.split('</script>').length - 1).toBe(1);
  });
});
