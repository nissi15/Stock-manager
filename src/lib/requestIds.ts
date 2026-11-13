/**
 * One id per save attempt, reused when the same thing is saved again shortly after a failure.
 * A request that times out may still have reached the database; when the user taps Save again,
 * the same id lets the database recognise the repeat and keep only one copy. After a success,
 * or after ten minutes, the same values get a fresh id, so a genuine second entry still saves.
 */
const reuseWindowMs = 10 * 60_000;
const attempts = new Map<string, { id: string; at: number }>();

const keyFor = (kind: string, input: unknown) => `${kind}:${JSON.stringify(input)}`;

export function requestIdFor(kind: string, input: unknown, now = Date.now()) {
  const key = keyFor(kind, input);
  const earlier = attempts.get(key);
  if (earlier && now - earlier.at < reuseWindowMs) return earlier.id;
  const id = crypto.randomUUID();
  attempts.set(key, { id, at: now });
  return id;
}

export function settleRequest(kind: string, input: unknown) {
  attempts.delete(keyFor(kind, input));
}

/** PostgREST: the RPC signature or table column is not there yet, because migration 0014 has not been run. */
export function isMissingSchema(error: { code?: string } | null | undefined) {
  return error?.code === 'PGRST202' || error?.code === 'PGRST204';
}
