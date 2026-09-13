import { describe, expect, test } from 'bun:test';
import {
  escapeXml,
  formatAmount,
  formatDate,
  formatISODateTime,
  formatTime,
  stripXmlDeclaration,
} from '../../src/utils/index.js';

// ---------------------------------------------------------------------------
// escapeXml — all five XML predefined entities
// ---------------------------------------------------------------------------

describe('escapeXml', () => {
  test('escapes < > & " \' everywhere in the string', () => {
    expect(escapeXml(`<a>&"'`)).toBe(`&lt;a&gt;&amp;&quot;&apos;`);
  });

  test('escapes multiple occurrences of each character', () => {
    expect(escapeXml('&&')).toBe('&amp;&amp;');
    expect(escapeXml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
    expect(escapeXml(`""''`)).toBe('&quot;&quot;&apos;&apos;');
  });

  test('leaves safe text untouched and handles the empty string', () => {
    expect(escapeXml('شركة الأبعاد للتجارة 123')).toBe('شركة الأبعاد للتجارة 123');
    expect(escapeXml('')).toBe('');
  });

  test('double-escapes already-escaped text (correct XML escaping semantics)', () => {
    // '&amp;' is the five-character TEXT "< &, ' " sequence: & → &amp; etc.
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

// ---------------------------------------------------------------------------
// formatAmount — BR-KSA-EN16931-11: amounts carry exactly 2 decimals
// ---------------------------------------------------------------------------

describe('formatAmount (2dp amounts, BT-131/BT-106/BT-109/BT-115)', () => {
  test('pads whole numbers and one-decimal amounts to 2dp', () => {
    expect(formatAmount(115)).toBe('115.00');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(15.5)).toBe('15.50');
  });

  test('keeps 2dp values unchanged', () => {
    expect(formatAmount(100.12)).toBe('100.12');
    expect(formatAmount(0.99)).toBe('0.99');
  });

  test('rounds to 2 decimals when the input carries more precision', () => {
    expect(formatAmount(1.999)).toBe('2.00');
    expect(formatAmount(1234567.891)).toBe('1234567.89');
  });

  test('formats negative amounts with the sign before the digits', () => {
    expect(formatAmount(-1.5)).toBe('-1.50');
  });
});

// ---------------------------------------------------------------------------
// stripXmlDeclaration
// ---------------------------------------------------------------------------

describe('stripXmlDeclaration', () => {
  test('removes the XML declaration and trims surrounding whitespace', () => {
    expect(stripXmlDeclaration('<?xml version="1.0" encoding="UTF-8"?>\n  <Invoice/>  ')).toBe('<Invoice/>');
  });

  test('leaves documents without a declaration intact (trimmed)', () => {
    expect(stripXmlDeclaration('  <Invoice/>  ')).toBe('<Invoice/>');
  });

  test('does not strip content that merely contains "?" characters', () => {
    expect(stripXmlDeclaration('<?xml version="1.0"?><note>why?</note>')).toBe('<note>why?</note>');
  });
});

// ---------------------------------------------------------------------------
// Date formatting — ZATCA IssueDate (YYYY-MM-DD), IssueTime (HH:MM:SS) and QR
// timestamp (ISO 8601 with Z) are all UTC-based
// ---------------------------------------------------------------------------

describe('formatDate / formatTime / formatISODateTime (UTC)', () => {
  const instant = new Date('2026-01-15T14:30:45.123Z');

  test('formats a Date into the ZATCA IssueDate/IssueTime components', () => {
    expect(formatDate(instant)).toBe('2026-01-15');
    expect(formatTime(instant)).toBe('14:30:45');
    expect(formatISODateTime(instant)).toBe('2026-01-15T14:30:45Z');
  });

  test('accepts ISO strings and converts them to UTC', () => {
    expect(formatDate('2026-03-05T22:15:30+03:00')).toBe('2026-03-05');
    expect(formatTime('2026-03-05T22:15:30+03:00')).toBe('19:15:30');
    expect(formatISODateTime('2026-03-05T22:15:30+03:00')).toBe('2026-03-05T19:15:30Z');
  });

  test('trims sub-second precision from the ISO output', () => {
    expect(formatISODateTime('2026-01-15T14:30:45.999Z')).toBe('2026-01-15T14:30:45Z');
  });

  test('round-trips a date-only ISO string', () => {
    expect(formatDate('2026-02-28')).toBe('2026-02-28');
    expect(formatISODateTime('2026-02-28T00:00:00Z')).toBe('2026-02-28T00:00:00Z');
  });

  test('rejects unparseable input (no silent Invalid Date output)', () => {
    expect(() => formatDate('not-a-date')).toThrow();
  });
});
