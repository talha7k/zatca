import { describe, expect, test } from 'bun:test';
import { add, sub, asDecimalString, isNegative } from '../../src/utils/money.js';
import { generateInvoiceXml } from '../../src/xml/index.js';
import { validateInvoice } from '../../src/utils/validation.js';
import { createTestInvoice } from '../integration/fixtures.js';

describe('money.add / money.sub (exact BigInt arithmetic)', () => {
  test('adds across mismatched scales without float drift', () => {
    expect(add('100', '15')).toBe('115');
    expect(add('100.00', '15')).toBe('115.00');
    expect(add('0.1', '0.2')).toBe('0.3'); // the classic float trap, exact here
    expect(add('1.5', '2')).toBe('3.5');
    expect(add('9007199254740993', '1')).toBe('9007199254740994'); // beyond 2^53
  });

  test('handles signs and mixed magnitudes', () => {
    expect(add('-5', '3')).toBe('-2');
    expect(add('5', '-3')).toBe('2');
    expect(add('-5', '-3')).toBe('-8');
    expect(sub('10', '3.5')).toBe('6.5');
    expect(sub('3.5', '10')).toBe('-6.5');
    expect(add('0', '-0')).toBe('0');
  });

  test('accepts numbers via shortest round-trip strings', () => {
    expect(add(100, 15)).toBe('115');
    // String(0.1)='0.1' and String(0.2)='0.2' are exact per-value — the sum
    // is exact too, unlike float 0.1+0.2.
    expect(add(0.1, 0.2)).toBe('0.3');
  });

  test('rejects malformed decimal strings', () => {
    expect(() => add('abc', '1')).toThrow(/xs:decimal/);
    expect(() => asDecimalString('1.2.3')).toThrow();
    expect(() => isNegative(Number.NaN)).toThrow();
  });
});

describe('asDecimalString / isNegative', () => {
  test('normalizes to minimal form', () => {
    expect(asDecimalString('007.5000')).toBe('7.5');
    expect(asDecimalString('-0.00')).toBe('0');
    expect(asDecimalString('100')).toBe('100');
  });

  test('negative detection excludes negative zero', () => {
    expect(isNegative('-0.01')).toBe(true);
    expect(isNegative('0')).toBe(false);
    expect(isNegative('-0')).toBe(false);
    expect(isNegative('12.5')).toBe(false);
  });
});

describe('decimal-typed documents (number | string end-to-end)', () => {
  test('string amounts produce byte-identical XML to their number twins', () => {
    const numeric = createTestInvoice();
    const stringify = (v: unknown): string => (typeof v === 'number' ? v.toFixed(2) : String(v));
    const textual = {
      ...numeric,
      lineExtensionAmount: stringify(numeric.lineExtensionAmount),
      taxExclusiveAmount: stringify(numeric.taxExclusiveAmount),
      taxInclusiveAmount: stringify(numeric.taxInclusiveAmount),
      payableAmount: stringify(numeric.payableAmount),
      taxAmount: stringify(numeric.taxAmount),
      taxSubtotals: numeric.taxSubtotals.map((s) => ({ ...s, taxableAmount: stringify(s.taxableAmount), taxAmount: stringify(s.taxAmount) })),
      invoiceLines: numeric.invoiceLines.map((l) => ({
        ...l,
        priceAmount: String(l.priceAmount),
        quantity: String(l.quantity),
        lineExtensionAmount: stringify(l.lineExtensionAmount),
        taxAmount: stringify(l.taxAmount),
      })),
    };
    expect(generateInvoiceXml(textual as never)).toBe(generateInvoiceXml(numeric));
  });

  test('validation accepts string totals and rejects negative string totals', () => {
    const invoice = { ...createTestInvoice(), taxAmount: '15.00', payableAmount: '115.00' };
    expect(() => validateInvoice(invoice as never)).not.toThrow();
    expect(() => validateInvoice({ ...invoice, taxAmount: '-1' } as never)).toThrow(/non-negative/);
  });

  test('full-precision string unit price and quantity survive emission', () => {
    const invoice = {
      ...createTestInvoice(),
      invoiceLines: [{
        ...createTestInvoice().invoiceLines[0],
        priceAmount: '33.3333333333',
        quantity: '0.125',
      }],
    };
    const xml = generateInvoiceXml(invoice as never);
    expect(xml).toContain('>0.125</cbc:InvoicedQuantity>');
    expect(xml).toContain('>33.3333333333</cbc:PriceAmount>');
  });
});
