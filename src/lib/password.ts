export function passwordRequirements(value: string) {
  return {
    length: value.length >= 12,
    uppercase: /[A-Z]/.test(value),
    lowercase: /[a-z]/.test(value),
    number: /\d/.test(value),
    symbol: /[^A-Za-z0-9\s]/.test(value)
  };
}

export function isStrongPassword(value: string) {
  return Object.values(passwordRequirements(value)).every(Boolean);
}
