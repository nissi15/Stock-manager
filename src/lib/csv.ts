/**
 * One CSV cell. Text that starts with = + - @ (or a tab or carriage return) is run as a formula
 * when the file is opened in Excel or Google Sheets, so a product or client named "=HYPERLINK(…)"
 * could act on the computer that opens the export. A leading apostrophe makes it plain text.
 * Numbers are left alone so a negative profit stays a number.
 */
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(rows: unknown[][]) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}
