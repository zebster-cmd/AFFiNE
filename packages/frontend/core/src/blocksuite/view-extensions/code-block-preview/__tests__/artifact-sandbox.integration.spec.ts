/**
 * @vitest-environment node
 *
 * End-to-end verification of the inline artifact renderer in real Chromium.
 *
 * The unit tests assert what we *write* (srcdoc, sandbox flags, message
 * handling). Those cannot prove what a browser actually *enforces*: that scripts
 * run, that forms work, that the guest is genuinely walled off from the host, and
 * that nothing reaches the network. That is what this spec covers.
 *
 * The wrapped document and the sandbox list are imported from production code so
 * this test cannot drift from what ships.
 */
import { createServer, type Server } from 'node:http';

import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ARTIFACT_MAX_HEIGHT, wrapArtifactHtml } from '../host-bootstrap';
import { ARTIFACT_SANDBOX } from '../iframe-container';

let server: Server;
let serverUrl: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body></body></html>');
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start artifact sandbox test server.');
  }
  serverUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

/** An artifact that is interactive: a scripted counter plus a real form. */
const INTERACTIVE_ARTIFACT = `<!DOCTYPE html>
<html>
<head><style>body { margin: 0; } #box { height: 300px; }</style></head>
<body>
  <div id="box">
    <button id="inc" onclick="bump()">inc</button>
    <span id="count">0</span>
    <form id="form"><input id="field" name="field" /></form>
  </div>
  <script>
    var n = 0;
    function bump() {
      n += 1;
      document.getElementById('count').textContent = String(n);
    }
  </script>
</body>
</html>`;

/**
 * Render an artifact the way production does: local srcdoc, real sandbox list,
 * host listening for guest messages.
 */
async function renderArtifact(
  artifactHtml: string,
  options: { extraSandbox?: readonly string[] } = {}
) {
  const page = await browser.newPage();
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));

  await page.goto(serverUrl);

  await page.evaluate(
    ({ srcdoc, sandbox }) => {
      const received: unknown[] = [];
      (window as any).__messages = received;
      window.addEventListener('message', event => {
        received.push(event.data);
      });

      const iframe = document.createElement('iframe');
      iframe.id = 'artifact';
      iframe.setAttribute('sandbox', sandbox.join(' '));
      iframe.srcdoc = srcdoc;
      document.body.append(iframe);
    },
    {
      srcdoc: wrapArtifactHtml(artifactHtml),
      sandbox: [...ARTIFACT_SANDBOX, ...(options.extraSandbox ?? [])],
    }
  );

  const frame = page.frameLocator('#artifact');
  await frame.locator('body').waitFor({ state: 'attached' });

  return { page, frame, requests };
}

/** Collect guest messages of a given type, polling until at least one lands. */
function guestMessages(page: Page, type: 'resize' | 'ready' | 'error') {
  return page.evaluate(async want => {
    const seen = () =>
      ((window as any).__messages as any[]).filter(m => m && m.type === want);
    for (let i = 0; i < 50 && seen().length === 0; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    return seen();
  }, type);
}

describe('artifact renderer in real Chromium', () => {
  test('runs artifact scripts', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      await frame.locator('#inc').click();
      await frame.locator('#inc').click();

      await expect.poll(() => frame.locator('#count').textContent()).toBe('2');
    } finally {
      await page.close();
    }
  });

  test('accepts form input', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      await frame.locator('#field').fill('hello');

      expect(await frame.locator('#field').inputValue()).toBe('hello');
    } finally {
      await page.close();
    }
  });

  test('reaches no network at all', async () => {
    const { page, requests } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      // Only the harness page itself; notably nothing to affine.run.
      expect(requests.filter(url => url.includes('affine.run'))).toEqual([]);
      expect(requests.every(url => url.startsWith(serverUrl))).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('reports its content height to the host', async () => {
    const { page } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      const resizes = await guestMessages(page, 'resize');

      expect(resizes.length).toBeGreaterThan(0);
      expect(resizes[0].source).toBe('affine-artifact');
      expect(resizes[0].height).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  test('announces readiness to the host', async () => {
    const { page } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      const ready = await guestMessages(page, 'ready');

      expect(ready.length).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});

describe('artifact isolation enforced by the browser', () => {
  test('the guest runs on an opaque origin', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      const origin = await frame
        .locator('body')
        .evaluate(() => String(window.origin));

      expect(origin).toBe('null');
    } finally {
      await page.close();
    }
  });

  test('the guest cannot read the host document', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      const reachedHost = await frame.locator('body').evaluate(() => {
        try {
          // Reading across an opaque origin must throw.
          return Boolean(window.parent.document.title !== undefined);
        } catch {
          return false;
        }
      });

      expect(reachedHost).toBe(false);
    } finally {
      await page.close();
    }
  });

  test('the guest cannot read host storage or cookies', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      await page.evaluate(() => {
        localStorage.setItem('affine-secret', 'token');
        document.cookie = 'affine-session=token';
      });

      const leaked = await frame.locator('body').evaluate(() => {
        let storage: string | null = null;
        try {
          storage = localStorage.getItem('affine-secret');
        } catch {
          // Opaque origins may refuse storage access outright.
          storage = null;
        }

        // Chromium throws SecurityError here rather than returning '' —
        // the sandbox denies cookie access entirely without allow-same-origin.
        let cookie: string | null = null;
        try {
          cookie = document.cookie;
        } catch {
          cookie = null;
        }

        return { storage, cookie };
      });

      expect(leaked.storage).toBeNull();
      expect(leaked.cookie ?? '').not.toContain('token');
    } finally {
      await page.close();
    }
  });
});

describe('allow-same-origin is what would collapse the boundary', () => {
  /**
   * Proves the isolation above is caused by the *absence* of
   * `allow-same-origin`, not by some incidental property of srcdoc — and that
   * the tests above would catch anyone adding the flag back.
   *
   * Production's list is never modified; the flag is added only here.
   */
  test('adding it lets the guest reach into the host', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT, {
      extraSandbox: ['allow-same-origin'],
    });

    try {
      const escaped = await frame.locator('body').evaluate(() => {
        try {
          return typeof window.parent.document.title === 'string';
        } catch {
          return false;
        }
      });

      expect(escaped).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('adding it drops the opaque origin', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT, {
      extraSandbox: ['allow-same-origin'],
    });

    try {
      const origin = await frame
        .locator('body')
        .evaluate(() => String(window.origin));

      expect(origin).not.toBe('null');
    } finally {
      await page.close();
    }
  });

  test('production never grants it', () => {
    expect([...ARTIFACT_SANDBOX]).not.toContain('allow-same-origin');
  });
});

describe('artifact state persistence', () => {
  test('hiding the frame preserves live artifact state', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      await frame.locator('#inc').click();
      expect(await frame.locator('#count').textContent()).toBe('1');

      // This is what the Code/Preview toggle now does.
      await page.evaluate(() => {
        document.getElementById('artifact')!.toggleAttribute('hidden', true);
      });
      await page.evaluate(() => {
        document.getElementById('artifact')!.toggleAttribute('hidden', false);
      });

      expect(await frame.locator('#count').textContent()).toBe('1');
    } finally {
      await page.close();
    }
  });

  test('re-creating the frame is what loses state', async () => {
    const { page, frame } = await renderArtifact(INTERACTIVE_ARTIFACT);

    try {
      await frame.locator('#inc').click();
      expect(await frame.locator('#count').textContent()).toBe('1');

      // The behaviour the old toggle caused, kept here so the reason the fix
      // matters stays visible.
      await page.evaluate(() => {
        const old = document.getElementById('artifact') as HTMLIFrameElement;
        const fresh = old.cloneNode(false) as HTMLIFrameElement;
        fresh.srcdoc = old.srcdoc;
        old.remove();
        document.body.append(fresh);
      });

      const fresh = page.frameLocator('#artifact');
      await expect.poll(() => fresh.locator('#count').textContent()).toBe('0');
    } finally {
      await page.close();
    }
  });
});

describe('artifact sizing', () => {
  test('reported height reflects tall content and the host caps it', async () => {
    const tall = `<!DOCTYPE html><html><body style="margin:0">
      <div style="height:5000px">tall</div></body></html>`;
    const { page } = await renderArtifact(tall);

    try {
      const height = (await guestMessages(page, 'resize')).at(-1)?.height ?? 0;

      // The guest reports the true content height...
      expect(height).toBeGreaterThan(ARTIFACT_MAX_HEIGHT);
      // ...and the host is what bounds it (see clampArtifactHeight unit tests).
    } finally {
      await page.close();
    }
  });

  test('short content reports a height well under the old fixed 544px', async () => {
    const short = `<!DOCTYPE html><html><body style="margin:0">
      <p style="height:40px;margin:0">short</p></body></html>`;
    const { page } = await renderArtifact(short);

    try {
      const height = (await guestMessages(page, 'resize')).at(-1)?.height ?? 0;

      expect(height).toBeGreaterThan(0);
      expect(height).toBeLessThan(544);
    } finally {
      await page.close();
    }
  });
});
