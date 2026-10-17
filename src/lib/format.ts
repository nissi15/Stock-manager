export const money = (value: number) => new Intl.NumberFormat('en-RW', { maximumFractionDigits: 0 }).format(Math.round(value || 0));
export const rwf = (value: number) => `RWF ${money(value)}`;
export const compactMoney = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const shortDate = (value: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
