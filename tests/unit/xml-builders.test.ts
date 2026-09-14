import { describe, expect, test } from 'bun:test';
import { XMLParser } from 'fast-xml-parser';
import { generateInvoiceXml } from '../../src/xml/invoice.js';
import { generateCreditNoteXml, generateDebitNoteXml } from '../../src/xml/credit-note.js';
import type { CreditNoteData, InvoiceData } from '../../src/types.js';

// UBL 2.1 + ZATCA XML Implementation Guide structural assertions. Output is
// parsed with fast-xml-parser so element names, namespaces, attributes, and
// 2dp/10dp amount formatting are checked structurally (not by string munging).

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

type Doc = Record<string, any>;
const parse = (xml: string): Doc => parser.parse(xml) as Doc;

function baseInvoice(): InvoiceData {
  return {
    invoiceNumber: 'INV-BUILD-001',
    uuid: '0b10645f-9df6-4971-9311-3fe3ec0b9305',
    issueDate: '2026-02-15',
    issueTime: '09:41:30',
    invoiceTypeCode: '388',
    invoiceTypeCodeName: '0100000',
    profileId: 'clearance:1.0',
    currencyCode: 'SAR',
    invoiceCounter: 42,
    previousInvoiceHash: 'aGVsbG8gcHJldmlvdXMgaW52b2ljZSBoYXNoIHZhbHVl',
    supplier: {
      nameAr: 'شركة الأبعاد للتجارة',
      nameEn: 'Al Abaad Trading Co',
      vatNumber: '310122393500003',
      crNumber: '1010512345',
      address: {
        street: 'King Fahd Road',
        building: '8228',
        district: 'Al Olaya',
        city: 'Riyadh',
        postalCode: '12345',
        countryCode: 'SA',
      },
    },
    customer: {
      name: 'Buyer Company Ltd',
      vatNumber: '300111222300003',
      address: {
        street: 'Prince Sultan Road',
        building: '3131',
        district: 'Al Aziziyah',
        city: 'Jeddah',
        postalCode: '23435',
        countryCode: 'SA',
      },
    },
    lineExtensionAmount: 100,
    taxExclusiveAmount: 100,
    taxInclusiveAmount: 115,
    payableAmount: 115,
    taxAmount: 15,
    taxSubtotals: [{ taxableAmount: 100, taxAmount: 15, percent: 15, taxCategoryId: 'S' }],
    invoiceLines: [{
      id: 1,
      quantity: 2,
      unitCode: 'C62',
      lineExtensionAmount: 100,
      taxAmount: 15,
      itemName: 'Test Product',
      taxCategoryId: 'S',
      taxPercent: 15,
      priceAmount: 50,
    }],
  };
}

const STANDARD_XML = generateInvoiceXml(baseInvoice());

describe('generateInvoiceXml — UBL 2.1 document envelope', () => {
  test('declares the four UBL 2.1 namespaces on the Invoice root', () => {
    const doc = parse(STANDARD_XML);

    expect(doc.Invoice['@_xmlns']).toBe('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
    expect(doc.Invoice['@_xmlns:cac']).toBe('urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2');
    expect(doc.Invoice['@_xmlns:cbc']).toBe('urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2');
    expect(doc.Invoice['@_xmlns:ext']).toBe('urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2');
  });

  test('emits header fields in the ZATCA-mandated order with 2.1 UBL version', () => {
    const doc = parse(STANDARD_XML);

    expect(doc.Invoice['cbc:UBLVersionID']).toBe('2.1');
    expect(doc.Invoice['cbc:ProfileID']).toBe('clearance:1.0');
    expect(doc.Invoice['cbc:ID']).toBe('INV-BUILD-001');
    expect(doc.Invoice['cbc:UUID']).toBe('0b10645f-9df6-4971-9311-3fe3ec0b9305');
    expect(doc.Invoice['cbc:IssueDate']).toBe('2026-02-15');
    expect(doc.Invoice['cbc:IssueTime']).toBe('09:41:30');
    expect(doc.Invoice['cbc:DocumentCurrencyCode']).toBe('SAR');
    expect(doc.Invoice['cbc:TaxCurrencyCode']).toBe('SAR');

    // ZATCA XSD sequence: UBLExtensions → UBLVersionID → ProfileID → ID →
    // UUID → IssueDate → IssueTime → InvoiceTypeCode → ... currency codes.
    const order = [
      STANDARD_XML.indexOf('<ext:UBLExtensions>'),
      STANDARD_XML.indexOf('<cbc:UBLVersionID>'),
      STANDARD_XML.indexOf('<cbc:ProfileID>'),
      STANDARD_XML.indexOf('<cbc:ID>'),
      STANDARD_XML.indexOf('<cbc:UUID>'),
      STANDARD_XML.indexOf('<cbc:IssueDate>'),
      STANDARD_XML.indexOf('<cbc:IssueTime>'),
      STANDARD_XML.indexOf('<cbc:InvoiceTypeCode'),
      STANDARD_XML.indexOf('<cbc:DocumentCurrencyCode>'),
      STANDARD_XML.indexOf('<cbc:TaxCurrencyCode>'),
    ];
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('encodes the type code with its name attribute (388/0100000 standard)', () => {
    const doc = parse(STANDARD_XML);

    expect(doc.Invoice['cbc:InvoiceTypeCode']['#text']).toBe('388');
    expect(doc.Invoice['cbc:InvoiceTypeCode']['@_name']).toBe('0100000');
  });

  test('leaves an empty ext:UBLExtensions placeholder for the signer', () => {
    const doc = parse(STANDARD_XML);
    const extensions = asArray<Doc>(doc.Invoice['ext:UBLExtensions']);

    expect(extensions).toHaveLength(1);
    const content = extensions[0]!['ext:UBLExtension']['ext:ExtensionContent'];
    expect(content === '' || content === undefined || content?.['#text'] === '').toBe(true);
  });
});

describe('generateInvoiceXml — document references and signature', () => {
  test('carries the ICV counter as an AdditionalDocumentReference', () => {
    const doc = parse(STANDARD_XML);
    const refs = asArray<Doc>(doc.Invoice['cac:AdditionalDocumentReference']);
    const icv = refs.find((ref) => ref['cbc:ID'] === 'ICV');

    expect(icv).toBeDefined();
    expect(icv!['cbc:UUID']).toBe('42');
  });

  test('carries the PIH inside an Attachment with mimeCode text/plain', () => {
    const doc = parse(STANDARD_XML);
    const refs = asArray<Doc>(doc.Invoice['cac:AdditionalDocumentReference']);
    const pih = refs.find((ref) => ref['cbc:ID'] === 'PIH');

    expect(pih).toBeDefined();
    const embedded = pih!['cac:Attachment']['cbc:EmbeddedDocumentBinaryObject'];
    expect(embedded['@_mimeCode']).toBe('text/plain');
    expect(embedded['#text']).toBe('aGVsbG8gcHJldmlvdXMgaW52b2ljZSBoYXNoIHZhbHVl');
  });

  test('omits the PIH reference when previousInvoiceHash is unset (caller supplies genesis)', () => {
    const xml = generateInvoiceXml({ ...baseInvoice(), previousInvoiceHash: undefined });
    const doc = parse(xml);
    const refs = asArray<Doc>(doc.Invoice['cac:AdditionalDocumentReference']);

    expect(refs.some((ref) => ref['cbc:ID'] === 'PIH')).toBe(false);
  });

  test('emits the UBL signature element with the enveloped-xades method', () => {
    const doc = parse(STANDARD_XML);
    const signature = doc.Invoice['cac:Signature'];

    expect(signature['cbc:ID']).toBe('urn:oasis:names:specification:ubl:signature:Invoice');
    expect(signature['cbc:SignatureMethod']).toBe('urn:oasis:names:specification:ubl:dsig:enveloped:xades');
  });
});

describe('generateInvoiceXml — parties', () => {
  test('supplier address children follow the ZATCA XSD sequence', () => {
    const doc = parse(STANDARD_XML);
    const party = doc.Invoice['cac:AccountingSupplierParty']['cac:Party'];
    const address = party['cac:PostalAddress'];

    expect(address['cbc:StreetName']).toBe('King Fahd Road');
    expect(address['cbc:BuildingNumber']).toBe('8228');
    expect(address['cbc:CitySubdivisionName']).toBe('Al Olaya');
    expect(address['cbc:CityName']).toBe('Riyadh');
    expect(address['cbc:PostalZone']).toBe('12345');
    expect(address['cac:Country']['cbc:IdentificationCode']).toBe('SA');

    const order = [
      STANDARD_XML.indexOf('<cbc:StreetName>'),
      STANDARD_XML.indexOf('<cbc:BuildingNumber>'),
      STANDARD_XML.indexOf('<cbc:CitySubdivisionName>'),
      STANDARD_XML.indexOf('<cbc:CityName>'),
      STANDARD_XML.indexOf('<cbc:PostalZone>'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('identifies the supplier CR with schemeID CRN when provided', () => {
    const doc = parse(STANDARD_XML);
    const party = doc.Invoice['cac:AccountingSupplierParty']['cac:Party'];
    const identification = asArray<Doc>(party['cac:PartyIdentification'])[0]!;

    expect(identification['cbc:ID']['#text']).toBe('1010512345');
    expect(identification['cbc:ID']['@_schemeID']).toBe('CRN');
  });

  test('names the supplier in PartyLegalEntity RegistrationName (Arabic)', () => {
    const doc = parse(STANDARD_XML);
    const party = doc.Invoice['cac:AccountingSupplierParty']['cac:Party'];

    expect(party['cac:PartyLegalEntity']['cbc:RegistrationName']).toBe('شركة الأبعاد للتجارة');
    expect(party['cac:PartyTaxScheme']['cbc:CompanyID']).toBe('310122393500003');
    expect(party['cac:PartyTaxScheme']['cac:TaxScheme']['cbc:ID']).toBe('VAT');
  });

  test('keeps an empty AccountingCustomerParty for simplified (B2C) invoices', () => {
    const xml = generateInvoiceXml({ ...baseInvoice(), customer: undefined });
    const doc = parse(xml);
    const customer = doc.Invoice['cac:AccountingCustomerParty'];

    expect(customer).toBeDefined();
    expect(customer['cac:Party']).toBeUndefined();
  });
});

describe('generateInvoiceXml — amounts and totals (BR-KSA-EN16931-11 2dp amounts) · totals formatting', () => {
  test('emits exactly two TaxTotal blocks (with breakdown + tax-currency total)', () => {
    const doc = parse(STANDARD_XML);
    const totals = asArray<Doc>(doc.Invoice['cac:TaxTotal']);

    expect(totals).toHaveLength(2);
    for (const total of totals) {
      expect(total['cbc:TaxAmount']['#text']).toBe('15.00');
      expect(total['cbc:TaxAmount']['@_currencyID']).toBe('SAR');
    }
    const withBreakdown = totals.find((total) => total['cac:TaxSubtotal'] !== undefined);
    const subtotal = asArray<Doc>(withBreakdown!['cac:TaxSubtotal'])[0]!;
    expect(subtotal['cbc:TaxableAmount']['#text']).toBe('100.00');
    expect(subtotal['cbc:TaxAmount']['#text']).toBe('15.00');
    expect(subtotal['cac:TaxCategory']['cbc:ID']).toBe('S');
    expect(subtotal['cac:TaxCategory']['cbc:Percent']).toBe('15.00');
    expect(subtotal['cac:TaxCategory']['cac:TaxScheme']['cbc:ID']).toBe('VAT');
  });

  test('formats LegalMonetaryTotal amounts at exactly 2 decimals with currencyID', () => {
    const doc = parse(STANDARD_XML);
    const total = doc.Invoice['cac:LegalMonetaryTotal'];

    expect(total['cbc:LineExtensionAmount']).toEqual({ '#text': '100.00', '@_currencyID': 'SAR' });
    expect(total['cbc:TaxExclusiveAmount']).toEqual({ '#text': '100.00', '@_currencyID': 'SAR' });
    expect(total['cbc:TaxInclusiveAmount']).toEqual({ '#text': '115.00', '@_currencyID': 'SAR' });
    expect(total['cbc:PayableAmount']).toEqual({ '#text': '115.00', '@_currencyID': 'SAR' });
  });

  test('line tax total rounds the line (RoundingAmount = line net + line tax)', () => {
    const doc = parse(STANDARD_XML);
    const line = asArray<Doc>(doc.Invoice['cac:InvoiceLine'])[0]!;

    expect(line['cbc:ID']).toBe('1');
    expect(line['cbc:InvoicedQuantity']).toEqual({ '#text': '2.00', '@_unitCode': 'C62' });
    expect(line['cbc:LineExtensionAmount']['#text']).toBe('100.00');
    expect(line['cac:TaxTotal']['cbc:TaxAmount']['#text']).toBe('15.00');
    expect(line['cac:TaxTotal']['cbc:RoundingAmount']['#text']).toBe('115.00');
    expect(line['cac:Item']['cbc:Name']).toBe('Test Product');
    expect(line['cac:Item']['cac:ClassifiedTaxCategory']['cbc:ID']).toBe('S');
    expect(line['cac:Price']['cbc:PriceAmount']['#text']).toBe('50.00');
  });
});

describe('generateInvoiceXml — amounts and totals · rounding & quantity precision', () => {
  test('rounds fractional amounts to 2 decimals in the XML output', () => {
    const xml = generateInvoiceXml({
      ...baseInvoice(),
      lineExtensionAmount: 100.456,
      taxExclusiveAmount: 100.456,
      taxInclusiveAmount: 115.5244,
      payableAmount: 115.5244,
      taxAmount: 15.0684,
      taxSubtotals: [{ taxableAmount: 100.456, taxAmount: 15.0684, percent: 15, taxCategoryId: 'S' }],
      invoiceLines: [{
        id: 1,
        quantity: 1,
        unitCode: 'C62',
        lineExtensionAmount: 100.456,
        taxAmount: 15.0684,
        itemName: 'Test Product',
        taxCategoryId: 'S',
        taxPercent: 15,
        priceAmount: 100.456,
      }],
    });
    const doc = parse(xml);

    expect(doc.Invoice['cac:LegalMonetaryTotal']['cbc:TaxInclusiveAmount']['#text']).toBe('115.52');
    expect(doc.Invoice['cac:LegalMonetaryTotal']['cbc:PayableAmount']['#text']).toBe('115.52');
    expect(asArray<Doc>(doc.Invoice['cac:TaxTotal'])[0]!['cbc:TaxAmount']['#text']).toBe('15.07');
  });

  // SPEC: BR-KSA-EN16931-11 limits MONETARY AMOUNTS (BT-131 etc.) to 2
  // decimals — quantities (BT-129 InvoicedQuantity) are not amounts. UBL's
  // DecimalType and ZATCA's XSD allow greater quantity precision, and
  // truncating quantity to 2dp breaks the price × quantity = line net
  // recomputation for unitCode values like KGM (sub-unit sales).
  test('preserves quantity precision beyond 2 decimals for weighted units', () => {
    const xml = generateInvoiceXml({
      ...baseInvoice(),
      invoiceLines: [{
        id: 1,
        quantity: 0.125,
        unitCode: 'KGM',
        lineExtensionAmount: 12.5,
        taxAmount: 1.88,
        itemName: 'Bulk Saffron',
        taxCategoryId: 'S',
        taxPercent: 15,
        priceAmount: 100,
      }],
    });
    const doc = parse(xml);
    const line = asArray<Doc>(doc.Invoice['cac:InvoiceLine'])[0]!;

    expect(line['cbc:InvoicedQuantity']['#text']).toBe('0.125');
  });
});

describe('generateInvoiceXml — XML escaping', () => {
  test('escapes XML special characters in text content', () => {
    const xml = generateInvoiceXml({
      ...baseInvoice(),
      invoiceNumber: `A<B&C"D'E`,
      supplier: {
        ...baseInvoice().supplier,
        nameAr: `مؤسسة & <"اختبار">`,
      },
    });
    const doc = parse(xml);

    // Round-trips: escaped content parses back to the original value.
    expect(doc.Invoice['cbc:ID']).toBe(`A<B&C"D'E`);
    expect(doc.Invoice['cac:AccountingSupplierParty']['cac:Party']['cac:PartyLegalEntity']['cbc:RegistrationName'])
      .toBe(`مؤسسة & <"اختبار">`);
    // And the raw output never contains an unescaped raw '<' inside text.
    expect(xml).toContain(`<cbc:ID>A&lt;B&amp;C&quot;D&apos;E</cbc:ID>`);
  });
});

function baseCreditNote(): CreditNoteData {
  return {
    ...baseInvoice(),
    invoiceNumber: 'CRN-BUILD-001',
    invoiceTypeCode: '381',
    invoiceTypeCodeName: '0100000',
    originalInvoiceNumber: 'INV-ORIGINAL-001',
    originalInvoiceUuid: 'c0ffeed0-1234-4567-89ab-000000000009',
    originalInvoiceDate: '2026-02-01',
    reason: 'Goods returned — defective unit',
  };
}

describe('generateCreditNoteXml · models credit notes on the Invoice root', () => {
  test('uses the Invoice root with the credit-note type code 381', () => {
    const doc = parse(generateCreditNoteXml(baseCreditNote()));

    expect(doc.Invoice).toBeDefined();
    expect(doc.Invoice['cbc:InvoiceTypeCode']['#text']).toBe('381');
    expect(doc.Invoice['cbc:InvoiceTypeCode']['@_name']).toBe('0100000');
    expect(doc.Invoice['cbc:ProfileID']).toBe('clearance:1.0');
  });

  test('references the original invoice via BillingReference/InvoiceDocumentReference', () => {
    const doc = parse(generateCreditNoteXml(baseCreditNote()));
    const reference = doc.Invoice['cac:BillingReference']['cac:InvoiceDocumentReference'];

    expect(reference['cbc:ID']).toBe('INV-ORIGINAL-001');
    expect(reference['cbc:UUID']).toBe('c0ffeed0-1234-4567-89ab-000000000009');
    expect(reference['cbc:IssueDate']).toBe('2026-02-01');
  });

  test('simplified credit note uses name 0200000 with the reporting profile', () => {
    const xml = generateCreditNoteXml({
      ...baseCreditNote(),
      invoiceTypeCodeName: '0200000',
      profileId: 'reporting:1.0',
      customer: undefined,
    });
    const doc = parse(xml);

    expect(doc.Invoice['cbc:InvoiceTypeCode']['@_name']).toBe('0200000');
    expect(doc.Invoice['cbc:ProfileID']).toBe('reporting:1.0');
    // ZATCA/UBL require the (possibly empty) AccountingCustomerParty even
    // for simplified B2C notes — pinned after the XSD fix (SDK conformance).
    // fast-xml-parser models the childless party as an empty string.
    expect(doc.Invoice['cac:AccountingCustomerParty']).toBe('');
  });
});

describe('generateDebitNoteXml (383)', () => {
  test('emits a 383-typed note with the BillingReference intact', () => {
    const note = { ...baseCreditNote(), invoiceTypeCode: '383' };
    const doc = parse(generateDebitNoteXml(note as CreditNoteData));
    expect(doc.Invoice['cbc:InvoiceTypeCode']['#text'] ?? doc.Invoice['cbc:InvoiceTypeCode']).toBe('383');
    expect(doc.Invoice['cac:BillingReference']).toBeDefined();
  });

  test('rejects a non-383 type code instead of emitting a mistyped note', () => {
    expect(() => generateDebitNoteXml({ ...baseCreditNote(), invoiceTypeCode: '381' })).toThrow(/383/);
  });
});

describe('generateCreditNoteXml · reason, ICV/PIH references & debit notes', () => {
  test('exposes the credit reason as cbc:Note and PaymentMeans InstructionNote', () => {
    const doc = parse(generateCreditNoteXml(baseCreditNote()));

    expect(doc.Invoice['cbc:Note']).toBe('Goods returned — defective unit');
    expect(doc.Invoice['cac:PaymentMeans']['cbc:PaymentMeansCode']).toBe('10');
    expect(doc.Invoice['cac:PaymentMeans']['cbc:InstructionNote']).toBe('Goods returned — defective unit');
  });

  test('keeps ICV/PIH references and the placeholder extensions block', () => {
    const xml = generateCreditNoteXml(baseCreditNote());
    const doc = parse(xml);
    const refs = asArray<Doc>(doc.Invoice['cac:AdditionalDocumentReference']);

    expect(refs.map((ref) => ref['cbc:ID'])).toContain('ICV');
    expect(refs.map((ref) => ref['cbc:ID'])).toContain('PIH');
    expect(doc.Invoice['ext:UBLExtensions']).toBeDefined();
  });

  test('debit note type code 383 is representable through the same builder', () => {
    const doc = parse(generateCreditNoteXml({
      ...baseCreditNote(),
      invoiceTypeCode: '383',
      reason: 'Price correction — debit',
    }));

    expect(doc.Invoice['cbc:InvoiceTypeCode']['#text']).toBe('383');
    expect(doc.Invoice['cbc:Note']).toBe('Price correction — debit');
  });
});
