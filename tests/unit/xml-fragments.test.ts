import { describe, expect, test } from 'bun:test';
import {
  xmlUBLExtensions,
  xmlAdditionalDocumentReferences,
  xmlSignature,
  xmlSupplierParty,
  xmlCustomerParty,
  xmlTaxTotalBlocks,
  xmlAllowanceCharges,
  xmlMonetaryTotal,
  xmlInvoiceLine,
} from '../../src/xml/fragments.js';
import { createTestInvoice } from '../integration/fixtures.js';

// Direct pins for the exported fragment builders. Their composition is
// covered end-to-end by xml-builders/credit-notes suites + SDK conformance;
// these pin each fragment's own contract (anchors, namespaces, formats).

const invoice = createTestInvoice();

describe('xmlUBLExtensions', () => {
  test('emits the empty placeholder signature stage expects', () => {
    expect(xmlUBLExtensions()).toContain('<ext:UBLExtensions>');
    expect(xmlUBLExtensions()).toContain('<ext:ExtensionContent/>');
  });
});

describe('xmlAdditionalDocumentReferences', () => {
  test('emits ICV and PIH attachments with the genesis PIH', () => {
    const refs = xmlAdditionalDocumentReferences(invoice);
    expect(refs).toContain('<cbc:ID>ICV</cbc:ID>');
    expect(refs).toContain('<cbc:ID>PIH</cbc:ID>');
    expect(refs).toContain('mimeCode="text/plain"');
  });
});

describe('xmlSignature', () => {
  test('uses the UBL xades enveloped signature method', () => {
    const sig = xmlSignature();
    expect(sig).toContain('urn:oasis:names:specification:ubl:signature:Invoice');
    expect(sig).toContain('dsig:enveloped:xades');
  });
});

describe('xmlSupplierParty / xmlCustomerParty', () => {
  test('supplier carries RegistrationName (Arabic), CRN and TRN', () => {
    const party = xmlSupplierParty(invoice.supplier);
    expect(party).toContain(`<cbc:RegistrationName>${invoice.supplier.nameAr}</cbc:RegistrationName>`);
    expect(party).toContain('schemeID="CRN"');
    expect(party).toContain(`<cbc:CompanyID>${invoice.supplier.vatNumber}</cbc:CompanyID>`);
  });

  test('customer party includes the postal address and registration name', () => {
    const party = xmlCustomerParty({ name: 'Buyer', vatNumber: '310000000000003', address: invoice.supplier.address });
    expect(party).toContain('<cac:PostalAddress>');
    expect(party).toContain('<cbc:RegistrationName>Buyer</cbc:RegistrationName>');
  });
});

describe('xmlTaxTotalBlocks / xmlMonetaryTotal', () => {
  test('tax totals carry the 2-dp amount and subtotals', () => {
    const blocks = xmlTaxTotalBlocks(invoice.taxAmount, invoice.currencyCode, invoice.taxSubtotals);
    expect(blocks).toContain(`<cbc:TaxAmount currencyID="SAR">${invoice.taxAmount.toFixed(2)}`);
    expect(blocks).toContain('<cac:TaxSubtotal>');
  });

  test('monetary total block pins the 2-dp payable amount', () => {
    const totals = xmlMonetaryTotal(invoice);
    expect(totals).toContain(`<cbc:PayableAmount currencyID="SAR">${invoice.payableAmount.toFixed(2)}`);
  });
});

describe('xmlAllowanceCharges', () => {
  test('renders nothing without allowances or charges', () => {
    expect(xmlAllowanceCharges({ ...invoice, allowances: [], charges: [] } as never)).toBe('');
  });
});

describe('xmlInvoiceLine', () => {
  test('emits quantity with unitCode and full-precision price', () => {
    const line = invoice.invoiceLines[0];
    const xml = xmlInvoiceLine({ ...line, priceAmount: 33.3333333333, quantity: 0.125 } as never, 'SAR');
    expect(xml).toContain('unitCode=');
    expect(xml).toContain('>0.125</cbc:InvoicedQuantity>');
    expect(xml).toContain('>33.3333333333</cbc:PriceAmount>');
  });
});
