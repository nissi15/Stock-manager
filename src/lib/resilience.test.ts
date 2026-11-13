import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createTimedFetch } from './timedFetch';
import { updateReady, watchForUpdates } from './appUpdate';
import { isRetryableSyncError } from './store';

vi.mock('./supabase', () => ({ supabase: null }));

afterEach(() => { vi.useRealTimers(); updateReady.set(false); });

const hangingFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
});

describe('request time limit', () => {
  it('gives up on a request that hangs, with an error the sync retries', async () => {
    vi.useFakeTimers();
    const request = createTimedFetch(20_000, hangingFetch)('https://example.test');
    const outcome = request.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await outcome as Error;
    expect(error.name).toBe('TimeoutError');
    expect(isRetryableSyncError({ code: '', message: `TypeError: ${error.message}` })).toBe(true);
  });

  it('passes a fast response through and still honours the caller cancelling', async () => {
    const ok = createTimedFetch(20_000, async () => new Response('ok'));
    expect(await (await ok('https://example.test')).text()).toBe('ok');
    const caller = new AbortController();
    const pending = createTimedFetch(20_000, hangingFetch)('https://example.test', { signal: caller.signal }).catch((error: Error) => error);
    caller.abort(new Error('cancelled by caller'));
    expect(((await pending) as Error).message).toBe('cancelled by caller');
  });
});

describe('new version prompt', () => {
  beforeEach(() => {
    const page = Object.assign(new EventTarget(), { setInterval: (handler: () => void, ms: number) => setInterval(handler, ms), clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer) });
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function fakeContainer(controller: object | null) {
    const target = new EventTarget();
    const update = vi.fn(async () => undefined);
    return { container: Object.assign(target, { controller, getRegistration: async () => ({ update }) }) as unknown as ServiceWorkerContainer, update, target };
  }

  it('asks for a reload when a new version takes over an open till', () => {
    const { container, target } = fakeContainer({});
    const stop = watchForUpdates(container);
    target.dispatchEvent(new Event('controllerchange'));
    expect(get(updateReady)).toBe(true);
    stop();
  });

  it('stays quiet on the first install on a new device', () => {
    const { container, target } = fakeContainer(null);
    const stop = watchForUpdates(container);
    target.dispatchEvent(new Event('controllerchange'));
    expect(get(updateReady)).toBe(false);
    stop();
  });

  it('checks for a new version on a timer', async () => {
    vi.useFakeTimers();
    const { container, update } = fakeContainer({});
    const stop = watchForUpdates(container, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(update).toHaveBeenCalled();
    stop();
  });
});
