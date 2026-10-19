import { describe, expect, it } from 'vitest';
import { isStrongPassword, passwordRequirements } from './password';

describe('signup password requirements', () => {
  it('requires length, both letter cases, a number, and a symbol', () => {
    expect(isStrongPassword('StrongPass12!')).toBe(true);
    for (const value of ['Short1!', 'lowercasepass1!', 'UPPERCASEPASS1!', 'NoNumberHere!', 'NoSymbolHere12']) {
      expect(isStrongPassword(value)).toBe(false);
    }
    expect(passwordRequirements('StrongPass12!')).toEqual({ length: true, uppercase: true, lowercase: true, number: true, symbol: true });
  });
});
