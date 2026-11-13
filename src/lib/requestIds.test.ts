import { describe, expect, it } from 'vitest';
import { isMissingSchema, requestIdFor, settleRequest } from './requestIds';

describe('save attempt ids', () => {
  const expense = { category: 'Transport', description: 'Moto', amount: 2000, method: 'cash' };

  it('reuses the id when the same expense is saved again after a failure', () => {
    const first = requestIdFor('expense', expense, 1_000);
    expect(requestIdFor('expense', { ...expense }, 60_000)).toBe(first);
  });

  it('gives a fresh id after a success, after ten minutes, or for different values', () => {
    const first = requestIdFor('expense', expense, 1_000);
    expect(requestIdFor('expense', { ...expense, amount: 2500 }, 1_000)).not.toBe(first);
    expect(requestIdFor('expense', expense, 1_000 + 10 * 60_000)).not.toBe(first);
    const again = requestIdFor('expense', expense, 2_000_000);
    settleRequest('expense', expense);
    expect(requestIdFor('expense', expense, 2_000_001)).not.toBe(again);
  });

  it('recognises the errors that mean the database migration has not been run', () => {
    expect(isMissingSchema({ code: 'PGRST202' })).toBe(true);
    expect(isMissingSchema({ code: 'PGRST204' })).toBe(true);
    expect(isMissingSchema({ code: '23505' })).toBe(false);
    expect(isMissingSchema(null)).toBe(false);
  });
});
