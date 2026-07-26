/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, test } from 'vitest';

import { linkIframe } from '../iframe-container';

const HTML = '<!DOCTYPE html><html><body><h1>hi</h1></body></html>';

describe('linkIframe', () => {
  let iframe: HTMLIFrameElement;

  beforeEach(() => {
    iframe = document.createElement('iframe');
    document.body.append(iframe);
  });

  test('renders the artifact locally via srcdoc', () => {
    linkIframe(iframe, HTML);

    expect(iframe.srcdoc).toContain('<h1>hi</h1>');
  });

  test('never navigates to a remote container', () => {
    linkIframe(iframe, HTML);

    expect(iframe.src).not.toContain('affine.run');
    expect(iframe.getAttribute('src')).toBeFalsy();
  });

  test('injects the host bootstrap into the rendered document', () => {
    linkIframe(iframe, HTML);

    expect(iframe.srcdoc).toContain('affine-artifact');
  });

  test('grants scripting so artifacts stay interactive', () => {
    linkIframe(iframe, HTML);

    expect(iframe.sandbox.contains('allow-scripts')).toBe(true);
  });

  test('withholds allow-same-origin so the guest gets an opaque origin', () => {
    linkIframe(iframe, HTML);

    expect(iframe.sandbox.contains('allow-same-origin')).toBe(false);
  });

  test('grants the interaction permissions artifacts need', () => {
    linkIframe(iframe, HTML);

    for (const flag of [
      'allow-forms',
      'allow-modals',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-downloads',
      'allow-pointer-lock',
    ]) {
      expect(iframe.sandbox.contains(flag), flag).toBe(true);
    }
  });

  test('re-linking replaces the previous content without a remote round trip', () => {
    linkIframe(iframe, HTML);
    linkIframe(
      iframe,
      '<!DOCTYPE html><html><body><h2>second</h2></body></html>'
    );

    expect(iframe.srcdoc).toContain('<h2>second</h2>');
    expect(iframe.srcdoc).not.toContain('<h1>hi</h1>');
    expect(iframe.sandbox.contains('allow-same-origin')).toBe(false);
  });
});
