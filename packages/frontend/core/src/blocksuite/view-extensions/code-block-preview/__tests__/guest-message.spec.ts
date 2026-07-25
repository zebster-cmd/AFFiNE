/**
 * @vitest-environment happy-dom
 *
 * Covers the host side of the artifact protocol: which guest messages are
 * trusted, and what the host does with them.
 *
 * The Lit component itself is not mounted here — `scripts/setup/lit.ts` stubs
 * `customElements` globally, so custom elements never upgrade in this
 * environment. The decision logic therefore lives in a pure function that can
 * be exercised against real iframes.
 */
import { beforeEach, describe, expect, test } from 'vitest';

import {
  ARTIFACT_MAX_HEIGHT,
  ARTIFACT_MESSAGE_SOURCE,
  ARTIFACT_MIN_HEIGHT,
  decideLink,
  resolveGuestMessage,
} from '../host-bootstrap';

let frame: HTMLIFrameElement;
let other: HTMLIFrameElement;

beforeEach(() => {
  document.body.innerHTML = '';
  frame = document.createElement('iframe');
  other = document.createElement('iframe');
  document.body.append(frame, other);
});

const event = (data: unknown, source: unknown) =>
  new MessageEvent('message', { data, source: source as MessageEventSource });

const resize = (height: number) => ({
  source: ARTIFACT_MESSAGE_SOURCE,
  type: 'resize',
  height,
});

const opts = { autoResize: true };

describe('resolveGuestMessage', () => {
  test('accepts a resize from the frame it is watching', () => {
    const result = resolveGuestMessage(
      event(resize(300), frame.contentWindow),
      frame,
      opts
    );

    expect(result).toEqual({ kind: 'resize', height: 300 });
  });

  test('clamps a reported height to the maximum', () => {
    const result = resolveGuestMessage(
      event(resize(99_999), frame.contentWindow),
      frame,
      opts
    );

    expect(result).toEqual({ kind: 'resize', height: ARTIFACT_MAX_HEIGHT });
  });

  test('clamps a reported height to the minimum', () => {
    const result = resolveGuestMessage(
      event(resize(1), frame.contentWindow),
      frame,
      opts
    );

    expect(result).toEqual({ kind: 'resize', height: ARTIFACT_MIN_HEIGHT });
  });

  test('rejects a message from a different frame', () => {
    const result = resolveGuestMessage(
      event(resize(300), other.contentWindow),
      frame,
      opts
    );

    expect(result).toEqual({ kind: 'ignore' });
  });

  test('rejects a message from the host window itself', () => {
    const result = resolveGuestMessage(event(resize(300), window), frame, opts);

    expect(result).toEqual({ kind: 'ignore' });
  });

  test('rejects a message with no source', () => {
    const result = resolveGuestMessage(event(resize(300), null), frame, opts);

    expect(result).toEqual({ kind: 'ignore' });
  });

  test('rejects everything when there is no frame yet', () => {
    const result = resolveGuestMessage(
      event(resize(300), frame.contentWindow),
      null,
      opts
    );

    expect(result).toEqual({ kind: 'ignore' });
  });

  test('rejects a payload without the artifact marker', () => {
    const result = resolveGuestMessage(
      event({ type: 'resize', height: 300 }, frame.contentWindow),
      frame,
      opts
    );

    expect(result).toEqual({ kind: 'ignore' });
  });

  test('ignores resize when auto-resize is disabled', () => {
    // The chat preview panel stretches the frame via CSS; writing an inline
    // height would override that rule and break the panel layout.
    const result = resolveGuestMessage(
      event(resize(300), frame.contentWindow),
      frame,
      { autoResize: false }
    );

    expect(result).toEqual({ kind: 'ignore' });
  });

  test('accepts ready even when auto-resize is disabled', () => {
    const result = resolveGuestMessage(
      event(
        { source: ARTIFACT_MESSAGE_SOURCE, type: 'ready' },
        frame.contentWindow
      ),
      frame,
      { autoResize: false }
    );

    expect(result).toEqual({ kind: 'ready' });
  });

  test('surfaces a guest error without discarding the render', () => {
    const result = resolveGuestMessage(
      event(
        { source: ARTIFACT_MESSAGE_SOURCE, type: 'error', message: 'boom' },
        frame.contentWindow
      ),
      frame,
      opts
    );

    expect(result).toEqual({ kind: 'error', message: 'boom' });
  });
});

describe('decideLink', () => {
  test('reports an empty state when there is no html', () => {
    expect(decideLink('', null, false)).toBe('empty');
    expect(decideLink(null, 'previous', true)).toBe('empty');
  });

  test('links html that has not been rendered yet', () => {
    expect(decideLink('<h1>a</h1>', null, false)).toBe('link');
  });

  test('skips relinking html that is already showing', () => {
    // Relinking would reload the frame and discard the artifact's live state.
    expect(decideLink('<h1>a</h1>', '<h1>a</h1>', true)).toBe('skip');
  });

  test('relinks when the html changes', () => {
    expect(decideLink('<h1>b</h1>', '<h1>a</h1>', true)).toBe('link');
  });

  test('relinks identical html that is not currently showing', () => {
    // e.g. a previous link threw, so the frame is not actually displaying it
    expect(decideLink('<h1>a</h1>', '<h1>a</h1>', false)).toBe('link');
  });
});
