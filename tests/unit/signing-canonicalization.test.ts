import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { canonicalizeForHash, computeInvoiceHash } from '../../src/signing/sign.js';
import { generateInvoiceXml } from '../../src/xml/invoice.js';
import type { InvoiceData } from '../../src/types.js';

// BR-KSA-26 / ZATCA SDK R3.4.8 hash pipeline: the invoice hash preimage is the
// canonicalized invoice XML with the UBLExtensions block, the cac:Signature
// element, and the QR AdditionalDocumentReference removed. The PIH
// AdditionalDocumentReference STAYS in the preimage (it is part of the
// document data being chained).

function baseInvoice(): InvoiceData {
  return {
    invoiceNumber: 'INV-CANON-001',
    uuid: '8f7a2b1c-0000-4000-8000-000000000001',
    issueDate: '2026-01-01',
    issueTime: '12:00:00',
    invoiceTypeCode: '388',
    invoiceTypeCodeName: '0100000',
    profileId: 'clearance:1.0',
    currencyCode: 'SAR',
    supplier: {
      nameAr: 'شركة نموذجية',
      nameEn: 'Test Company Ltd',
      vatNumber: '300000000000003',
      address: {
        street: 'King Fahd Road',
        building: '1234',
        district: 'Al Olaya',
        city: 'Riyadh',
        postalCode: '12345',
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
      quantity: 1,
      unitCode: 'C62',
      lineExtensionAmount: 100,
      taxAmount: 15,
      itemName: 'Test Product',
      taxCategoryId: 'S',
      taxPercent: 15,
      priceAmount: 100,
    }],
    invoiceCounter: 7,
    previousInvoiceHash: 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  };
}

const INVOICE_XML = generateInvoiceXml(baseInvoice());

// The QR element is injected adjacently (no extra whitespace), matching how
// insertQr embeds it during signing, so stripping it restores the exact
// pre-signing canonical byte layout.
const WITH_QR_XML = INVOICE_XML.replace(
  '<cac:Signature>',
  '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment>' +
    '<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">QVNR</cbc:EmbeddedDocumentBinaryObject>' +
    '</cac:Attachment></cac:AdditionalDocumentReference><cac:Signature>',
);

describe('canonicalizeForHash (ZATCA SDK hash pipeline) · preimage selection', () => {
  test('strips UBLExtensions, cac:Signature and the QR reference from the preimage', () => {
    const { canonical } = canonicalizeForHash(INVOICE_XML);

    expect(canonical).not.toContain('UBLExtensions');
    expect(canonical).not.toContain('<cac:Signature');
    expect(canonical).not.toContain('<cbc:ID>QR</cbc:ID>');
    // Exactly one EmbeddedDocumentBinaryObject survives: the PIH attachment.
    expect(canonical.match(/<cbc:EmbeddedDocumentBinaryObject/g)).toHaveLength(1);
    // The PIH document reference is invoice data and must survive.
    expect(canonical).toContain('<cbc:ID>PIH</cbc:ID>');
    expect(canonical).toContain('NWZlY2Vi');
    // Core document data survives.
    expect(canonical).toContain('INV-CANON-001');
    expect(canonical).toContain('8f7a2b1c-0000-4000-8000-000000000001');
  });

  test('replacing the UBLExtensions placeholder with signature content does not change the hash', () => {
    const withSignatureContent = INVOICE_XML.replace(
      '<ext:ExtensionContent/>',
      '<ext:ExtensionContent>' +
        '<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" ' +
        'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:Signature>garbage</ds:Signature></sig:UBLDocumentSignatures>' +
        '</ext:ExtensionContent>',
    );

    expect(withSignatureContent).not.toBe(INVOICE_XML);
    expect(canonicalizeForHash(withSignatureContent).hashBase64)
      .toBe(canonicalizeForHash(INVOICE_XML).hashBase64);
  });
});

describe('canonicalizeForHash (ZATCA SDK hash pipeline) · hash determinism & sensitivity', () => {
  test('hash is SHA-256 over the returned canonical string (hex + base64 forms agree)', () => {
    const { canonical, hash, hashBase64 } = canonicalizeForHash(INVOICE_XML);
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest();

    expect(hash).toBe(digest.toString('hex'));
    expect(hashBase64).toBe(digest.toString('base64'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBase64).toHaveLength(44);
  });

  test('is deterministic for identical input', () => {
    expect(canonicalizeForHash(INVOICE_XML).hashBase64)
      .toBe(canonicalizeForHash(INVOICE_XML).hashBase64);
  });

  test('adding a QR AdditionalDocumentReference does not change the hash', () => {
    expect(WITH_QR_XML).toContain('<cbc:ID>QR</cbc:ID>');
    expect(canonicalizeForHash(WITH_QR_XML).hashBase64).toBe(canonicalizeForHash(INVOICE_XML).hashBase64);
  });

  test('stripQR=false keeps the QR reference in the canonical preimage', () => {
    const { canonical } = canonicalizeForHash(WITH_QR_XML, false);
    expect(canonical).toContain('<cbc:ID>QR</cbc:ID>');
    expect(canonicalizeForHash(WITH_QR_XML, false).hashBase64)
      .not.toBe(canonicalizeForHash(WITH_QR_XML).hashBase64);
  });

  test('mutating core invoice data changes the hash', () => {
    const changedUuid = generateInvoiceXml({
      ...baseInvoice(),
      uuid: '8f7a2b1c-0000-4000-8000-000000000002',
    });

    expect(canonicalizeForHash(changedUuid).hashBase64)
      .not.toBe(canonicalizeForHash(INVOICE_XML).hashBase64);
  });
});

describe('computeInvoiceHash', () => {
  // NOTE: this export returns the HEX digest, while ZATCA consumers (API body
  // invoiceHash, QR tag 6, PIH) need the BASE64 form (hashBase64). The test
  // pins the hex contract so a future change to base64 is a conscious one —
  // flagged in the coverage report as a docstring/behavior mismatch risk.
  test('equals canonicalizeForHash().hash (64-char lowercase hex of the canonical XML)', () => {
    const { hash } = canonicalizeForHash(INVOICE_XML);

    expect(computeInvoiceHash(INVOICE_XML)).toBe(hash);
    expect(computeInvoiceHash(INVOICE_XML)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('excludes UBLExtensions/signature/QR from the preimage like the SDK', () => {
    const withSignatureContent = INVOICE_XML.replace(
      '<ext:ExtensionContent/>',
      '<ext:ExtensionContent><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">junk</ds:Signature></ext:ExtensionContent>',
    );

    expect(computeInvoiceHash(withSignatureContent)).toBe(computeInvoiceHash(INVOICE_XML));
  });
});
