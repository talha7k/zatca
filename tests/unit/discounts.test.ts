import { describe, expect, test } from 'bun:test';
import { XMLParser } from 'fast-xml-parser';
import { generateInvoiceXml } from '../../src/index.js';
import { createDiscountedTestInvoice } from '../integration/fixtures.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function parseInvoice(xml: string): any {
  return parser.parse(xml).Invoice;
}

describe('invoice discount allowance charges', () => {
  test('emits document-level allowance charge for invoice discounts', () => {
    const invoice = createDiscountedTestInvoice();

    const xml = generateInvoiceXml(invoice);
    const parsed = parseInvoice(xml);

    expect(xml).toContain('<cbc:AllowanceTotalAmount currencyID="SAR">10.00</cbc:AllowanceTotalAmount>');
    expect(xml).toContain('<cbc:ID>PIH</cbc:ID>');
    expect(xml).toContain('<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">');
    expect(parsed['cac:AllowanceCharge']['cbc:ChargeIndicator']).toBe(false);
    expect(parsed['cac:AllowanceCharge']['cbc:AllowanceChargeReason']).toBe('Discount');
    expect(parsed['cac:AllowanceCharge']['cbc:Amount']['#text']).toBe(10);
    expect(parsed['cac:AllowanceCharge']['cbc:Amount']['@_currencyID']).toBe('SAR');
    expect(parsed['cac:TaxTotal'][0]['cac:TaxSubtotal']['cbc:TaxableAmount']['#text']).toBe(90);
    expect(parsed['cac:LegalMonetaryTotal']['cbc:PayableAmount']['#text']).toBe(103.5);
  });

  test('emits line-level allowance charge for allocated header discounts', () => {
    const invoice = createDiscountedTestInvoice({
      lineExtensionAmount: 90,
      taxExclusiveAmount: 90,
      taxInclusiveAmount: 103.5,
      allowanceTotalAmount: 10,
      allowanceCharges: undefined,
      payableAmount: 103.5,
      taxAmount: 13.5,
      invoiceLines: [
        {
          id: 1,
          quantity: 1,
          unitCode: 'PCE',
          lineExtensionAmount: 90,
          taxAmount: 13.5,
          itemName: 'Product',
          taxCategoryId: 'S',
          taxPercent: 15,
          priceAmount: 100,
          allowanceCharges: [
            {
              chargeIndicator: false,
              reason: 'Discount',
              amount: 10,
            },
          ],
        },
      ],
    });

    const xml = generateInvoiceXml(invoice);
    const parsed = parseInvoice(xml);
    const line = parsed['cac:InvoiceLine'];

    expect(line['cbc:LineExtensionAmount']['#text']).toBe(90);
    expect(line['cac:AllowanceCharge']['cbc:ChargeIndicator']).toBe(false);
    expect(line['cac:AllowanceCharge']['cbc:AllowanceChargeReason']).toBe('Discount');
    expect(line['cac:AllowanceCharge']['cbc:Amount']['#text']).toBe(10);
    expect(line['cac:AllowanceCharge']['cbc:Amount']['@_currencyID']).toBe('SAR');
    expect(line['cac:TaxTotal']['cbc:TaxAmount']['#text']).toBe(13.5);
  });
});
