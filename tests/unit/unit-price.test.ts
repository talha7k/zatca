import { describe, expect, test } from 'bun:test';
import { generateInvoiceXml } from '../../src/index.js';
import { formatUnitPrice } from '../../src/utils/xml.js';
import { createTestInvoice } from '../integration/fixtures.js';

// BR-KSA-EN16931-11 (2026-09-09): the 2-decimal restriction applies to AMOUNTS,
// not the ITEM NET PRICE (BT-146). Unit prices need up to 10 decimals so that
// price × qty recomputes the line net (BT-131) exactly — ZATCA XML IG §9.3;
// Odoo l10n_sa_edi ships 10-dp PriceAmount and passes validation.
describe('formatUnitPrice (BT-146)', () => {
  test('formats whole numbers with the 2dp minimum', () => {
    expect(formatUnitPrice(15)).toBe('15.00');
  });

  test('pads one-decimal prices to the 2dp minimum', () => {
    expect(formatUnitPrice(2.5)).toBe('2.50');
  });

  test('trims trailing zeros down to the 2dp minimum', () => {
    expect(formatUnitPrice(2.3)).toBe('2.30');
  });

  test('preserves up to 10 decimal places', () => {
    expect(formatUnitPrice(33.3333333333)).toBe('33.3333333333');
  });

  test('preserves non-zero 10th decimal digit', () => {
    expect(formatUnitPrice(1.0000000001)).toBe('1.0000000001');
  });

  test('falls back to toFixed(2) for non-finite values', () => {
    expect(formatUnitPrice(Number.NaN)).toBe('NaN');
    expect(formatUnitPrice(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(formatUnitPrice(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  test('price × qty recomputes the line net from the unrounded value', () => {
    const price = 33.3333333333;
    const quantity = 3;

    const formatted = formatUnitPrice(price);
    expect(formatted).toBe('33.3333333333');

    // The formatted price round-trips to the exact same double, so the
    // recomputed line net matches the unrounded computation bit-for-bit,
    // and settles to the 2dp amount emitted as BT-131.
    expect(parseFloat(formatted) * quantity).toBe(price * quantity);
    expect((parseFloat(formatted) * quantity).toFixed(2)).toBe('100.00');
  });
});

describe('invoice XML emits unit price at full precision (BT-146)', () => {
  test('emits 10-dp PriceAmount for fractional unit prices', () => {
    const invoice = createTestInvoice({
      invoiceLines: [
        {
          id: 1,
          quantity: 3,
          unitCode: 'PCE',
          lineExtensionAmount: 100,
          taxAmount: 15,
          itemName: 'Fractional Product',
          taxCategoryId: 'S',
          taxPercent: 15,
          priceAmount: 33.3333333333,
        },
      ],
    });

    const xml = generateInvoiceXml(invoice);

    expect(xml).toContain('>33.3333333333</cbc:PriceAmount>');
  });

  test('still emits 2-dp PriceAmount for simple unit prices', () => {
    const xml = generateInvoiceXml(createTestInvoice());

    expect(xml).toContain('>2.00</cbc:PriceAmount>');
  });
});
