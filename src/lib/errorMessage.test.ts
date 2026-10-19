import { describe, expect, it } from 'vitest';
import { errorMessage } from './errorMessage';

describe('errorMessage', () => {
  it('shows the message from a Supabase error object', () => {
    expect(errorMessage({ code: 'P0001', message: 'Close the previous day first' }))
      .toBe('Close the previous day first');
  });

  it('does not display [object Object] for an unexpected error shape', () => {
    expect(errorMessage({ code: 'P0001' })).toBe('Something went wrong. Please try again.');
  });

  it('explains connection failures', () => {
    expect(errorMessage(new Error('Failed to fetch')))
      .toBe('Cannot reach Supabase. Check your internet connection and try again.');
  });
});
