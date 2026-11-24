/** The CDP compatibility boundary must support Playwright's proxy channel and fail closed otherwise. */
import type { BrowserContext, Page } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { registerCdpSelectors, requireCdpShadowTracking } from '../../src/cdp-selectors.ts';
import { CLOSED_SHADOW_ROOTS_KEY } from '../../src/closed-shadow.ts';
import { SELECTOR_ENGINES } from '../../src/selector-engines.ts';

const TRACKING_SYMBOL = Symbol.for(CLOSED_SHADOW_ROOTS_KEY);

const budget = () => ({ timeoutMs: 500, signal: new AbortController().signal });

afterEach(() => {
  Reflect.deleteProperty(globalThis, TRACKING_SYMBOL);
});

it('refuses an unsupported context before any locator or capture can run, naming both', async () => {
  await expect(registerCdpSelectors({} as BrowserContext, budget())).rejects.toMatchObject({
    code: 'UNSUPPORTED_CAPABILITY',
    message: expect.stringMatching(/locators and secure-field masks/),
  });
});

it('tolerates only the exact owned-name duplicates from a version that already seeded the context', async () => {
  const register = vi.fn();
  for (const { name } of SELECTOR_ENGINES) {
    register.mockRejectedValueOnce(new Error(`"${name}" selector engine has been already registered`));
  }
  register.mockRejectedValueOnce(new Error('"other" selector engine has been already registered'));
  const context = { _channel: { registerSelectorEngine: register } } as unknown as BrowserContext;
  await expect(registerCdpSelectors(context, budget())).resolves.toBeUndefined();
  await expect(registerCdpSelectors(context, budget())).rejects.toThrow('"other"');
});

it('requires both the tracking record and queryLightAndOpen helper on every CDP frame', async () => {
  const trackedFrame = { evaluate: async <A, R>(fn: (arg: A) => R, arg: A) => fn(arg) };
  const singleFramePage = { frames: () => [trackedFrame] } as unknown as Page;

  await expect(requireCdpShadowTracking(singleFramePage, budget())).rejects.toMatchObject({
    code: 'ENGINE_FAILURE',
    message: expect.stringMatching(/closed shadow root tracking or the queryLightAndOpen mask helper is unavailable/),
  });

  const incomplete = new WeakMap();
  Object.defineProperty(globalThis, TRACKING_SYMBOL, { value: incomplete, configurable: true, writable: true });
  await expect(requireCdpShadowTracking(singleFramePage, budget())).rejects.toMatchObject({
    code: 'ENGINE_FAILURE',
    message: expect.stringMatching(/closed shadow root tracking or the queryLightAndOpen mask helper is unavailable/),
  });

  Object.defineProperty(incomplete, 'queryLightAndOpen', { value: () => [], configurable: true });
  const twoTrackedFramesPage = { frames: () => [trackedFrame, trackedFrame] } as unknown as Page;
  await expect(requireCdpShadowTracking(twoTrackedFramesPage, budget())).resolves.toBeUndefined();

  // Rejects when a second frame lacks the tracking record even if the first frame passes.
  const untrackedSecondFrame = { evaluate: async () => false };
  const mixedFramesPage = { frames: () => [trackedFrame, untrackedSecondFrame] } as unknown as Page;
  await expect(requireCdpShadowTracking(mixedFramesPage, budget())).rejects.toMatchObject({
    code: 'ENGINE_FAILURE',
    message: expect.stringMatching(/closed shadow root tracking or the queryLightAndOpen mask helper is unavailable/),
  });
});
