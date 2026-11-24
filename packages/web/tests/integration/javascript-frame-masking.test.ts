/**
 * Secure-field masking across rewritten `javascript:false` and `javascript:void(0)`
 * iframes in Chromium and WebKit: light DOM, open shadow roots, and nested closed
 * shadow roots must all be masked without stalling Playwright's capture in WebKit,
 * and page overrides of DOM query prototypes must not suppress light/open masking.
 */

import { existsSync } from 'node:fs';
import { webkit, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OperationContext } from '@e2e-dev/core/engine';
import { BrowserConnection, defaultChromiumSandbox } from '../../src/browser-connection.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
import { captureObservation } from '../../src/observation-capture.ts';
import { capturePixels, maskOptions, secureFieldMasks } from '../../src/observe.ts';
import { RefRegistry } from '../../src/refs.ts';
import { decodePng } from '../helpers/png.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

const VIEWPORT = { width: 420, height: 340 } as const;

const operation: OperationContext = {
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  runId: 'run-js-frame-mask',
  attemptId: 'attempt-1',
  origin: 'agent',
};

/**
 * Builds an HTML document with 6 password inputs (light DOM, open shadow root,
 * closed shadow root, nested closed-in-closed, closed-in-open, and open-in-closed)
 * plus a red control and a green control at fixed coordinates for pixel verification.
 */
const FRAME_DOCUMENT_HTML = `<!doctype html>
<html>
<head>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #ffffff; width: 380px; height: 280px; position: relative; overflow: hidden; }
  input[type="password"] { display: block; width: 140px; height: 30px; background: #0000ff; border: 0; }
</style>
</head>
<body>
  <input id="pw-light" type="password" value="light-secret" style="position:absolute; left:10px; top:10px;">
  <div id="host-open" style="position:absolute; left:10px; top:50px;"></div>
  <div id="host-closed" style="position:absolute; left:10px; top:90px;"></div>
  <div id="host-nested-closed" style="position:absolute; left:10px; top:130px;"></div>
  <div id="host-open-closed" style="position:absolute; left:10px; top:170px;"></div>
  <div id="host-closed-open" style="position:absolute; left:10px; top:210px;"></div>
  <div id="red-box" style="position:absolute; left:200px; top:10px; width:80px; height:40px; background:rgb(255, 0, 0);"></div>
  <div id="green-box" style="position:absolute; left:200px; top:70px; width:80px; height:40px; background:rgb(0, 255, 0);"></div>
  <script>
    const style = 'input[type="password"]{display:block;width:140px;height:30px;background:#0000ff;border:0;}';

    const open = document.getElementById('host-open').attachShadow({ mode: 'open' });
    open.innerHTML = '<style>' + style + '</style><input type="password" value="open-secret">';

    const closed = document.getElementById('host-closed').attachShadow({ mode: 'closed' });
    closed.innerHTML = '<style>' + style + '</style><input type="password" value="closed-secret">';

    const outerClosed = document.getElementById('host-nested-closed').attachShadow({ mode: 'closed' });
    outerClosed.innerHTML = '<div id="inner-host"></div>';
    const innerClosed = outerClosed.getElementById('inner-host').attachShadow({ mode: 'closed' });
    innerClosed.innerHTML = '<style>' + style + '</style><input type="password" value="nested-closed-secret">';

    const outerOpen = document.getElementById('host-open-closed').attachShadow({ mode: 'open' });
    outerOpen.innerHTML = '<div id="inner-closed-host"></div>';
    const closedInOpen = outerOpen.getElementById('inner-closed-host').attachShadow({ mode: 'closed' });
    closedInOpen.innerHTML = '<style>' + style + '</style><input type="password" value="closed-in-open-secret">';

    const closedOuter = document.getElementById('host-closed-open').attachShadow({ mode: 'closed' });
    closedOuter.innerHTML = '<div id="inner-open-host"></div>';
    const openInClosed = closedOuter.getElementById('inner-open-host').attachShadow({ mode: 'open' });
    openInClosed.innerHTML = '<style>' + style + '</style><input type="password" value="open-in-closed-secret">';
  </script>
</body>
</html>`;

/** Coordinates of the 6 password inputs and 2 control boxes relative to the viewport (iframe sits at 20,20). */
const PASSWORD_CENTERS = [
  { name: 'light DOM password', x: 20 + 80, y: 20 + 25 },
  { name: 'open shadow password', x: 20 + 80, y: 20 + 65 },
  { name: 'closed shadow password', x: 20 + 80, y: 20 + 105 },
  { name: 'nested closed shadow password', x: 20 + 80, y: 20 + 145 },
  { name: 'closed-in-open shadow password', x: 20 + 80, y: 20 + 185 },
  { name: 'open-in-closed shadow password', x: 20 + 80, y: 20 + 225 },
] as const;

const RED_CONTROL = { x: 20 + 240, y: 20 + 30 } as const;
const GREEN_CONTROL = { x: 20 + 240, y: 20 + 90 } as const;

function expectMaskedPixels(bytes: Uint8Array, fields: readonly { readonly name: string; readonly x: number; readonly y: number }[] = PASSWORD_CENTERS): void {
  const image = decodePng(bytes);
  for (const field of fields) {
    const [r, g, b, a] = image.pixelAt(field.x, field.y);
    expect({ field: field.name, pixel: [r, g, b, a] }).toEqual({ field: field.name, pixel: [0, 0, 0, 255] });
  }
  const [rr, rg, rb] = image.pixelAt(RED_CONTROL.x, RED_CONTROL.y);
  expect(rr).toBeGreaterThan(200);
  expect(rg).toBeLessThan(50);
  expect(rb).toBeLessThan(50);

  const [gr, gg, gb] = image.pixelAt(GREEN_CONTROL.x, GREEN_CONTROL.y);
  expect(gr).toBeLessThan(50);
  expect(gg).toBeGreaterThan(200);
  expect(gb).toBeLessThan(50);
}

type FrameKind = 'http' | 'javascript:false' | 'javascript:void(0)';

async function openIframePage(context: BrowserContext, appUrl: string, kind: FrameKind): Promise<Page> {
  const page = await context.newPage();
  await page.route('**/iframe-fixture.html', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT_HTML }),
  );
  await page.goto(appUrl);
  await page.evaluate(({ frameKind, html }) => {
    document.body.style.margin = '0';
    document.body.style.background = '#ffffff';
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute; left:20px; top:20px; width:380px; height:280px; border:0;';
    if (frameKind === 'http') {
      iframe.src = '/iframe-fixture.html';
      document.body.appendChild(iframe);
      return;
    }
    iframe.src = frameKind;
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(html);
    doc.close();
  }, { frameKind: kind, html: FRAME_DOCUMENT_HTML });

  if (kind === 'http') {
    await page.waitForFunction(() => {
      const iframe = document.querySelector('iframe');
      return iframe?.contentDocument?.getElementById('pw-light') !== null;
    });
  }
  return page;
}

const browsers: readonly { readonly name: 'chromium' | 'webkit'; readonly available: boolean }[] = [
  { name: 'chromium', available: true },
  { name: 'webkit', available: existsSync(webkit.executablePath()) },
];

for (const { name, available } of browsers) {
  describe.skipIf(!available)(`rewritten javascript-URL iframe masking (${name})`, () => {
    const connection = new BrowserConnection();
    let app: FixtureApp;
    let context: BrowserContext;
    let opened: Page | undefined;

    beforeAll(async () => {
      app = await startFixtureApp();
      const browser: Browser = await connection.acquire({
        name,
        headed: false,
        timeoutMs: 30_000,
        chromiumSandbox: defaultChromiumSandbox(),
      });
      context = await browser.newContext({ viewport: VIEWPORT });
      await context.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
    });

    afterEach(async () => {
      await opened?.close();
      opened = undefined;
    });

    afterAll(async () => {
      await context?.close();
      await connection.dispose();
      await app?.close();
    });

    for (const kind of ['http', 'javascript:false', 'javascript:void(0)'] as const) {
      it(`masks light, open, and nested closed shadow password fields in a ${kind} iframe`, async () => {
        const page = await openIframePage(context, app.url, kind);
        opened = page;

        const capture = await capturePixels(page, operation, VIEWPORT);
        expect(capture.maskingProven).toBe(true);
        expect(capture.maskedRegionCount).toBe(6);
        expectMaskedPixels(capture.pixels.data);

        const { snapshot } = await captureObservation(
          page,
          new RefRegistry(),
          { testIdAttribute: 'data-testid', site: app.url },
          operation,
          { pixels: true },
        );
        expect(snapshot.pixels).toBeDefined();
        expect(snapshot.maskedRegionCount).toBe(6);
        expectMaskedPixels(snapshot.pixels!.data);

        const masks = await secureFieldMasks(page);
        const artifact = await page.screenshot({
          type: 'png',
          scale: 'css',
          animations: 'disabled',
          caret: 'initial',
          timeout: 5_000,
          ...maskOptions(masks),
        });
        expectMaskedPixels(new Uint8Array(artifact));
      });
    }

    it('masks light and open shadow password fields even when page scripts override querySelectorAll and shadowRoot', async () => {
      const page = await openIframePage(context, app.url, 'javascript:false');
      opened = page;

      await page.evaluate(() => {
        const win = document.querySelector('iframe')!.contentWindow as Window & typeof globalThis;
        win.Document.prototype.querySelectorAll = (() => []) as unknown as typeof Document.prototype.querySelectorAll;
        win.Element.prototype.querySelectorAll = (() => []) as unknown as typeof Element.prototype.querySelectorAll;
        win.ShadowRoot.prototype.querySelectorAll = (() => []) as unknown as typeof ShadowRoot.prototype.querySelectorAll;
        Object.defineProperty(win.Element.prototype, 'shadowRoot', { get: () => null, configurable: true });
      });

      const capture = await capturePixels(page, operation, VIEWPORT);
      expect(capture.maskingProven).toBe(true);
      expectMaskedPixels(capture.pixels.data, PASSWORD_CENTERS.slice(0, 2));
    });
  });
}
