import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('CSV export', () => {
  it('turns text that a spreadsheet would run as a formula into plain text', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell('+250 788')).toBe(`"'+250 788"`);
    expect(csvCell('-cash')).toBe(`"'-cash"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
  });

  it('leaves ordinary text and numbers, including negative profit, unchanged', () => {
    expect(csvCell('2 x Zahabu rice')).toBe('"2 x Zahabu rice"');
    expect(csvCell(-5000)).toBe('"-5000"');
    expect(toCsv([['Client', 'Profit'], ['Walk-in', 1200]])).toBe('"Client","Profit"\n"Walk-in","1200"');
  });
});
