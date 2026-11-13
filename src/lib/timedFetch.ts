/** How long one request to Supabase may take before it is abandoned. */
export const requestTimeoutMs = 20_000;

/**
 * fetch with a time limit. A request that hangs instead of failing would otherwise keep the
 * offline-sale sync "in flight" for minutes and block every later attempt. The abort error
 * says "timeout", which the sync treats as retryable, so the sale stays queued and retries.
 */
export function createTimedFetch(timeoutMs = requestTimeoutMs, baseFetch: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  return (input, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`Request timeout after ${timeoutMs / 1000}s`, 'TimeoutError')), timeoutMs);
    const callerSignal = init.signal;
    const forwardAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) forwardAbort();
    else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
    return baseFetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    });
  };
}
