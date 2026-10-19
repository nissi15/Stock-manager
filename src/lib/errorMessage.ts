export function errorMessage(error: unknown): string {
  let detail = error instanceof Error ? error.message : '';
  if (!detail && error && typeof error === 'object') {
    const value = error as { message?: unknown; error_description?: unknown; details?: unknown };
    const candidate = value.message ?? value.error_description ?? value.details;
    if (typeof candidate === 'string') detail = candidate;
  }
  if (!detail && typeof error === 'string') detail = error;
  if (!detail || detail === '[object Object]') return 'Something went wrong. Please try again.';
  return /failed to fetch|networkerror|internet_disconnected/i.test(detail)
    ? 'Cannot reach Supabase. Check your internet connection and try again.'
    : detail;
}
