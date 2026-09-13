import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import {
  asCertificatePem,
  buildComplianceInvoiceXml,
  DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH,
  extractInvoiceTimestamp,
  extractInvoiceUuid,
  extractXmlValue,
  normalizeArabicDigits,
  normalizeZatcaBuildingNumber,
  normalizeZatcaPostalCode,
  type ZatcaComplianceCheckType,
} from '../../src/compliance/index.js';
import type { SupplierInfo } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const parse = (xml: string): any => parser.parse(xml);

const SUPPLIER: SupplierInfo = {
  nameAr: 'شركة الحلول',
  nameEn: 'Solutions Co',
  vatNumber: '300000000000003',
  address: {
    street: 'King Fahd Road',
    building: '1234',
    district: 'Al Olaya',
    city: 'Riyadh',
    postalCode: '12345',
    countryCode: 'SA',
  },
};

const DETERMINISTIC_INPUT = {
  supplier: SUPPLIER,
  uuid: 'd5a4f1e0-7777-4aaa-8bbb-000000001234',
  invoiceNumber: 'COMPLIANCE-001',
  issueDate: '2026-03-10',
  issueTime: '14:05:09',
};

// ---------------------------------------------------------------------------
// normalizeArabicDigits
// ---------------------------------------------------------------------------

describe('normalizeArabicDigits', () => {
  test('converts Arabic-Indic digits (U+0660–U+0669) to ASCII', () => {
    expect(normalizeArabicDigits('١٢٣٤٥')).toBe('12345');
    expect(normalizeArabicDigits('٠')).toBe('0');
  });

  test('converts Extended Arabic-Indic digits (U+06F0–U+06F9) to ASCII', () => {
    expect(normalizeArabicDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  test('normalizes digits inside mixed Arabic text and leaves non-digits untouched', () => {
    expect(normalizeArabicDigits('فاتورة ٤٥ بتاريخ ٢٠٢٦')).toBe('فاتورة 45 بتاريخ 2026');
    expect(normalizeArabicDigits('INV-001')).toBe('INV-001');
    expect(normalizeArabicDigits('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ZATCA address normalization (BR-KSA-39/40: building number ≥ 4 digits,
// postal code = 5 digits)
// ---------------------------------------------------------------------------

describe('normalizeZatcaBuildingNumber (4 digits)', () => {
  test('zero-pads short numbers to 4 digits', () => {
    expect(normalizeZatcaBuildingNumber('12')).toBe('0012');
    expect(normalizeZatcaBuildingNumber('7')).toBe('0007');
  });

  test('normalizes Arabic-Indic building numbers', () => {
    expect(normalizeZatcaBuildingNumber('١٢٣')).toBe('0123');
  });

  test('keeps 4-digit numbers unchanged and strips separators', () => {
    expect(normalizeZatcaBuildingNumber('1234')).toBe('1234');
    expect(normalizeZatcaBuildingNumber('9999-9999')).toBe('9999');
  });

  test('passes through input containing no digits at all', () => {
    expect(normalizeZatcaBuildingNumber('N/A')).toBe('N/A');
    expect(normalizeZatcaBuildingNumber('')).toBe('');
  });
});

describe('normalizeZatcaPostalCode (5 digits)', () => {
  test('zero-pads short codes to 5 digits', () => {
    expect(normalizeZatcaPostalCode('123')).toBe('00123');
    expect(normalizeZatcaPostalCode('1234')).toBe('01234');
  });

  test('normalizes Arabic-Indic postal codes', () => {
    expect(normalizeZatcaPostalCode('١٢٣٤')).toBe('01234');
  });

  test('keeps 5-digit codes unchanged', () => {
    expect(normalizeZatcaPostalCode('12345')).toBe('12345');
    expect(normalizeZatcaPostalCode('11564')).toBe('11564');
  });

  test('passes through input containing no digits at all', () => {
    expect(normalizeZatcaPostalCode('--')).toBe('--');
    expect(normalizeZatcaPostalCode('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// asCertificatePem (PEM / base64 DER / double-encoded DER)
// ---------------------------------------------------------------------------

// Real SPKI DER blob for an EC P-256 key — starts with the 0x30 SEQUENCE tag,
// which is all asCertificatePem inspects.
const DER_BASE64 = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200' +
    '04abcd0000000000000000000000000000000000000000000000000000000000' +
    '00ef01010101010101010101010101010101010101010101010101010101010101',
  'hex',
).toString('base64');

describe('asCertificatePem', () => {
  test('returns an already-PEM certificate unchanged', () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${DER_BASE64.match(/.{1,8}/g)!.join('\n')}\n-----END CERTIFICATE-----`;

    expect(asCertificatePem(pem)).toBe(pem);
  });

  test('wraps raw base64 DER in a PEM envelope with 64-char lines', () => {
    const pem = asCertificatePem(DER_BASE64);

    expect(pem.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
    expect(pem.endsWith('\n-----END CERTIFICATE-----')).toBe(true);
    for (const line of pem.split('\n')) {
      if (!line.startsWith('-----')) expect(line.length).toBeLessThanOrEqual(64);
    }
    expect(pem.replace(/-----[A-Z ]+-----|\n/g, '')).toBe(DER_BASE64);
  });

  test('decodes double-encoded DER (base64 of base64 DER)', () => {
    const doubleEncoded = Buffer.from(DER_BASE64).toString('base64');
    const pem = asCertificatePem(doubleEncoded);

    expect(pem).toContain('-----BEGIN CERTIFICATE-----');
    expect(pem.replace(/-----[A-Z ]+-----|\n/g, '')).toBe(DER_BASE64);
  });

  test('decodes base64 of PEM text back to the PEM', () => {
    const pemText = `-----BEGIN CERTIFICATE-----\n${DER_BASE64}\n-----END CERTIFICATE-----`;
    const encoded = Buffer.from(pemText).toString('base64');

    expect(asCertificatePem(encoded)).toBe(pemText);
  });
});

// ---------------------------------------------------------------------------
// XML extraction helpers
// ---------------------------------------------------------------------------

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>INV-EX-001</cbc:ID>
  <cbc:UUID>d5a4f1e0-7777-4aaa-8bbb-000000001234</cbc:UUID>
  <cbc:IssueDate>2026-03-10</cbc:IssueDate>
  <cbc:IssueTime>14:05:09</cbc:IssueTime>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
  </cac:TaxTotal>
</Invoice>`;

describe('extractXmlValue / extractInvoiceUuid / extractInvoiceTimestamp', () => {
  test('extracts cbc: values including elements that carry attributes', () => {
    expect(extractXmlValue(SAMPLE_XML, 'UUID')).toBe('d5a4f1e0-7777-4aaa-8bbb-000000001234');
    expect(extractXmlValue(SAMPLE_XML, 'IssueDate')).toBe('2026-03-10');
    expect(extractXmlValue(SAMPLE_XML, 'TaxAmount')).toBe('15.00');
  });

  test('returns null for missing elements', () => {
    expect(extractXmlValue(SAMPLE_XML, 'PayableAmount')).toBeNull();
    expect(extractInvoiceUuid('<cbc:ID>no-uuid</cbc:ID>')).toBeNull();
  });

  test('extractInvoiceTimestamp joins IssueDate and IssueTime as ISO local time', () => {
    expect(extractInvoiceTimestamp(SAMPLE_XML)).toBe('2026-03-10T14:05:09');
  });

  test('strips a trailing Z from the IssueTime component', () => {
    const xml = SAMPLE_XML.replace('<cbc:IssueTime>14:05:09</cbc:IssueTime>', '<cbc:IssueTime>14:05:09Z</cbc:IssueTime>');

    expect(extractInvoiceTimestamp(xml)).toBe('2026-03-10T14:05:09');
  });

  test('falls back to a second-precision current timestamp when fields are missing', () => {
    const fallback = extractInvoiceTimestamp('<cbc:ID>x</cbc:ID>');

    expect(fallback).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// buildComplianceInvoiceXml — type-code / profile / customer matrix
// ---------------------------------------------------------------------------

const COMPLIANCE_MATRIX: Array<{
  checkType: ZatcaComplianceCheckType;
  typeCode: string;
  typeName: string;
  profileId: string;
  standardCustomer: boolean;
}> = [
  { checkType: 'SIMPLIFIED_INVOICE', typeCode: '388', typeName: '0200000', profileId: 'reporting:1.0', standardCustomer: false },
  { checkType: 'STANDARD_INVOICE', typeCode: '388', typeName: '0100000', profileId: 'clearance:1.0', standardCustomer: true },
  { checkType: 'SIMPLIFIED_CREDIT_NOTE', typeCode: '381', typeName: '0200000', profileId: 'reporting:1.0', standardCustomer: false },
  { checkType: 'STANDARD_CREDIT_NOTE', typeCode: '381', typeName: '0100000', profileId: 'clearance:1.0', standardCustomer: true },
  { checkType: 'SIMPLIFIED_DEBIT_NOTE', typeCode: '383', typeName: '0200000', profileId: 'reporting:1.0', standardCustomer: false },
  { checkType: 'STANDARD_DEBIT_NOTE', typeCode: '383', typeName: '0100000', profileId: 'clearance:1.0', standardCustomer: true },
];

describe('buildComplianceInvoiceXml · compliance check type matrix', () => {
  for (const entry of COMPLIANCE_MATRIX) {
    test(`${entry.checkType} → type ${entry.typeCode}/${entry.typeName}, ${entry.profileId}`, () => {
      const built = buildComplianceInvoiceXml({ ...DETERMINISTIC_INPUT, checkType: entry.checkType });
      const doc = parse(built.invoiceXml);

      expect(doc.Invoice['cbc:InvoiceTypeCode']['#text']).toBe(entry.typeCode);
      expect(doc.Invoice['cbc:InvoiceTypeCode']['@_name']).toBe(entry.typeName);
      expect(doc.Invoice['cbc:ProfileID']).toBe(entry.profileId);
      expect(doc.Invoice['cbc:UUID']).toBe(DETERMINISTIC_INPUT.uuid);
      expect(doc.Invoice['cbc:ID']).toBe('COMPLIANCE-001');
      expect(built.uuid).toBe(DETERMINISTIC_INPUT.uuid);

      const customer = doc.Invoice['cac:AccountingCustomerParty'];
      if (entry.standardCustomer) {
        // Standard (B2B) compliance docs carry a default customer.
        expect(customer?.['cac:Party']?.['cac:PartyLegalEntity']?.['cbc:RegistrationName']).toBe('Compliance Test Customer');
      } else {
        // Simplified (B2C) docs keep the customer element empty.
        expect(customer?.['cac:Party']).toBeUndefined();
      }
    });
  }
});

describe('buildComplianceInvoiceXml · BT-25 billing references', () => {
  test('credit note compliance docs reference the original invoice (BT-25)', () => {
    for (const checkType of ['SIMPLIFIED_CREDIT_NOTE', 'STANDARD_CREDIT_NOTE'] as const) {
      const built = buildComplianceInvoiceXml({
        ...DETERMINISTIC_INPUT,
        checkType,
        originalInvoiceNumber: 'ORIG-INV-77',
        originalInvoiceUuid: 'e6e6e6e6-1111-4222-8333-444444444444',
        originalInvoiceDate: '2026-03-01',
      });
      const doc = parse(built.invoiceXml);
      const reference = doc.Invoice['cac:BillingReference']['cac:InvoiceDocumentReference'];

      expect(reference['cbc:ID']).toBe('ORIG-INV-77');
      expect(reference['cbc:UUID']).toBe('e6e6e6e6-1111-4222-8333-444444444444');
      expect(reference['cbc:IssueDate']).toBe('2026-03-01');
    }
  });

  // SPEC: EN 16931 BR-E-10/BR-D-10 — a credit note (381) AND a debit note
  // (383) must each carry an Invoice reference (BT-25, cac:BillingReference).
  // The debit-note patch inserts it via a regex anchored on the OPTIONAL ICV
  // AdditionalDocumentReference, so with no invoiceCounter (the default) the
  // reference is silently dropped and ZATCA would reject the document.
  test('debit note compliance docs reference the original invoice (BT-25)', () => {
    for (const checkType of ['SIMPLIFIED_DEBIT_NOTE', 'STANDARD_DEBIT_NOTE'] as const) {
      const built = buildComplianceInvoiceXml({
        ...DETERMINISTIC_INPUT,
        checkType,
        originalInvoiceNumber: 'ORIG-INV-77',
        originalInvoiceUuid: 'e6e6e6e6-1111-4222-8333-444444444444',
        originalInvoiceDate: '2026-03-01',
      });
      const doc = parse(built.invoiceXml);
      const reference = doc.Invoice['cac:BillingReference']['cac:InvoiceDocumentReference'];

      expect(reference['cbc:ID']).toBe('ORIG-INV-77');
      expect(reference['cbc:UUID']).toBe('e6e6e6e6-1111-4222-8333-444444444444');
      expect(reference['cbc:IssueDate']).toBe('2026-03-01');
    }
  });
});

describe('buildComplianceInvoiceXml · document contents', () => {
  test('debit note docs carry the reason note and credit/debit payment means', () => {
    const built = buildComplianceInvoiceXml({
      ...DETERMINISTIC_INPUT,
      checkType: 'SIMPLIFIED_DEBIT_NOTE',
      originalInvoiceUuid: 'e6e6e6e6-1111-4222-8333-444444444444',
    });
    const doc = parse(built.invoiceXml);

    expect(doc.Invoice['cbc:Note']).toBe('Compliance test debit note');
    expect(doc.Invoice['cac:PaymentMeans']['cbc:PaymentMeansCode']).toBe('10');
    expect(doc.Invoice['cac:PaymentMeans']['cbc:InstructionNote']).toBe('Compliance test debit note');
  });

  test('defaults the PIH to the BR-KSA-26 genesis hash when previousInvoiceHash is unset', () => {
    const built = buildComplianceInvoiceXml({ ...DETERMINISTIC_INPUT, checkType: 'SIMPLIFIED_INVOICE' });
    const doc = parse(built.invoiceXml);
    const refs = (Array.isArray(doc.Invoice['cac:AdditionalDocumentReference'])
      ? doc.Invoice['cac:AdditionalDocumentReference']
      : [doc.Invoice['cac:AdditionalDocumentReference']]
    ) as Array<Record<string, any>>;
    const pih = refs.find((ref) => ref['cbc:ID'] === 'PIH');

    expect(pih).toBeDefined();
    expect(pih!['cac:Attachment']['cbc:EmbeddedDocumentBinaryObject']['#text'])
      .toBe(DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH);
    // The genesis constant is base64 of the UTF-8 hex of sha256("0").
    expect(Buffer.from(DEFAULT_COMPLIANCE_PREVIOUS_INVOICE_HASH, 'base64').toString('utf8'))
      .toBe(crypto.createHash('sha256').update('0').digest('hex'));
  });

  test('normalizes supplier building number and postal code into the XML', () => {
    const built = buildComplianceInvoiceXml({
      checkType: 'SIMPLIFIED_INVOICE',
      supplier: {
        ...SUPPLIER,
        address: { ...SUPPLIER.address, building: '٣٤٥', postalCode: '١٢٣٤' },
      },
      uuid: DETERMINISTIC_INPUT.uuid,
      issueDate: DETERMINISTIC_INPUT.issueDate,
      issueTime: DETERMINISTIC_INPUT.issueTime,
    });
    const doc = parse(built.invoiceXml);
    const address = doc.Invoice['cac:AccountingSupplierParty']['cac:Party']['cac:PostalAddress'];

    expect(address['cbc:BuildingNumber']).toBe('0345');
    expect(address['cbc:PostalZone']).toBe('01234');
  });

  test('is deterministic when every randomizable input is pinned', () => {
    const a = buildComplianceInvoiceXml({ ...DETERMINISTIC_INPUT, checkType: 'STANDARD_INVOICE' });
    const b = buildComplianceInvoiceXml({ ...DETERMINISTIC_INPUT, checkType: 'STANDARD_INVOICE' });

    expect(a.invoiceXml).toBe(b.invoiceXml);
    expect(a.uuid).toBe(b.uuid);
  });
});
