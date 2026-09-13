import { afterEach, describe, expect, test } from 'bun:test';
import { XMLParser } from 'fast-xml-parser';
import {
  extractCertificateSignature,
  generateCreditNoteXml,
  resolveSubmissionType,
  signInvoice,
  submitDocument,
  ZatcaApiClient,
  ZatcaError,
} from '../../src/index.js';
import type { ZatcaDocumentData } from '../../src/types.js';
import { createTestCreditNote, createTestInvoice } from '../integration/fixtures.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

const TEST_PRIVATE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJMvO+IgiLq3YBJaSp7Gz1a7786pQ/u9ZPauVY54NQZ6oAoGCCqGSM49
AwEHoUQDQgAEz3vRHcXK1dgFsLqXdbNzSETiEIuC6rFmpmN697nECxPtRDR5vNC2
GhPoO6rtwp4+BttdIhIWo8HSMSYGsfiipA==
-----END EC PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBdzCCAR2gAwIBAgIUaumRZCMc9o3ZxLuAISSXffuresEwCgYIKoZIzj0EAwIw
ETEPMA0GA1UEAwwGdGVzdGNhMB4XDTI2MDUwMTExMjg1NloXDTI3MDUwMTExMjg1
NlowETEPMA0GA1UEAwwGdGVzdGNhMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
z3vRHcXK1dgFsLqXdbNzSETiEIuC6rFmpmN697nECxPtRDR5vNC2GhPoO6rtwp4+
BttdIhIWo8HSMSYGsfiipKNTMFEwHQYDVR0OBBYEFDpE5pXNp2qWghXpkJavkHIb
uDU+MB8GA1UdIwQYMBaAFDpE5pXNp2qWghXpkJavkHIbuDU+MA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAP2Okl6ZMxD8xABvIDDUBycGcZNqUl0o
pBLnzUm2S9AiAiBLlAutK/rCJOb6EkHHaMYHgQREBZdiLhlf6NR1WMYGBA==
-----END CERTIFICATE-----`;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockZatcaResponse(body: unknown): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

function submitTestDocument(invoice: ZatcaDocumentData) {
  return submitDocument({
    invoice,
    privateKeyPem: TEST_PRIVATE_KEY,
    certificatePem: TEST_CERT,
    certificateSignature: extractCertificateSignature(TEST_CERT),
    credentials: { binarySecurityToken: 'token', secret: 'secret' },
    apiConfig: {
      environment: 'sandbox',
      sandboxUrl: 'https://sandbox.example.test',
      timeout: 1000,
    },
  });
}

describe('ZATCA credit notes', () => {
  test('generates refund credit note XML with ZATCA credit-note code and reason', () => {
    const creditNote = createTestCreditNote({
      invoiceTypeCode: '381',
      invoiceTypeCodeName: '0200000',
      reason: 'Customer returned item',
    });

    const xml = generateCreditNoteXml(creditNote);
    const parsed = parser.parse(xml).Invoice;

    expect(xml).toContain('<Invoice');
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>');
    expect(parsed['cbc:InvoiceTypeCode']['#text']).toBe(381);
    expect(parsed['cbc:InvoiceTypeCode']['@_name']).toBe('0200000');
    expect(parsed['cac:BillingReference']['cac:InvoiceDocumentReference']['cbc:ID']).toBe(
      creditNote.originalInvoiceNumber,
    );
    expect(parsed['cbc:Note']).toBe('Customer returned item');
    expect(parsed['cac:DiscrepancyResponse']).toBeUndefined();
    expect(parsed['cac:PaymentMeans']['cbc:InstructionNote']).toBe('Customer returned item');
    expect(parsed['cac:InvoiceLine']['cbc:InvoicedQuantity']['#text']).toBe(2);
    expect(xml).toContain('<cbc:ID>PIH</cbc:ID>');
    expect(xml).toContain('<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">');

    expect(xml.indexOf('<cac:BillingReference>')).toBeLessThan(
      xml.indexOf('<cac:AdditionalDocumentReference>'),
    );
    expect(xml).not.toContain('<cac:DiscrepancyResponse>');
    expect(xml.indexOf('<cac:PaymentMeans>')).toBeLessThan(xml.indexOf('<cac:TaxTotal>'));
  });

  test('routes standard invoices and credit notes by subtype, not by document code', () => {
    expect(
      resolveSubmissionType(
        createTestInvoice({
          invoiceTypeCode: '388',
          invoiceTypeCodeName: '0100000',
          profileId: 'clearance:1.0',
        }),
      ),
    ).toBe('CLEARANCE');

    expect(
      resolveSubmissionType(
        createTestCreditNote({
          invoiceTypeCode: '381',
          invoiceTypeCodeName: '0200000',
          profileId: 'reporting:1.0',
        }),
      ),
    ).toBe('REPORTING');

    expect(
      resolveSubmissionType(
        createTestCreditNote({
          invoiceTypeCode: '381',
          invoiceTypeCodeName: '0100000',
          profileId: 'clearance:1.0',
        }),
      ),
    ).toBe('CLEARANCE');
  });

  test('submits simplified credit notes to reporting endpoint', async () => {
    const calls = mockZatcaResponse({
      reportingStatus: 'REPORTED',
      uuid: 'reported-credit-note',
      invoiceHash: 'hash',
      validationResults: { errorMessages: [], warningMessages: [] },
    });

    const result = await submitTestDocument(
      createTestCreditNote({
        invoiceTypeCode: '381',
        invoiceTypeCodeName: '0200000',
        profileId: 'reporting:1.0',
      }),
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sandbox.example.test/invoices/reporting/single');
    expect(JSON.parse(calls[0].body).invoice).toBeTruthy();
    expect(result.signedXml).toContain('<Invoice');
    expect(result.signedXml).toContain(
      '<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>',
    );
  });

  test('signs credit notes with invoice-root signature references for ZATCA compatibility', () => {
    const xml = generateCreditNoteXml(createTestCreditNote());
    const signed = signInvoice({
      xml,
      privateKeyPem: TEST_PRIVATE_KEY,
      certificatePem: TEST_CERT,
      qrData: {
        sellerName: 'شركة اختبار',
        vatNumber: '300000000000003',
        timestamp: '2026-01-01T12:00:00',
        totalWithVat: '4.60',
        vatTotal: '0.60',
        certificateSignature: extractCertificateSignature(TEST_CERT),
      },
    });

    expect(signed.signedXml).toContain(
      '<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>',
    );
    expect(signed.signedXml).toContain('<cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>');
  });

  test('submits standard tax invoices to clearance endpoint while keeping code 388', async () => {
    const calls = mockZatcaResponse({
      acceptedInvoices: [
        {
          uuid: 'cleared-standard-invoice',
          invoiceHash: 'hash',
          clearanceStatus: 'CLEARED',
        },
      ],
    });

    const result = await submitTestDocument(
      createTestInvoice({
        invoiceTypeCode: '388',
        invoiceTypeCodeName: '0100000',
        profileId: 'clearance:1.0',
        customer: {
          name: 'VAT Buyer',
          vatNumber: '300000000000003',
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sandbox.example.test/invoices/clearance/single');
    expect(result.signedXml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
  });

  test('surfaces ZATCA reporting hard errors as structured alerts', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          reportingStatus: 'NOT_REPORTED',
          validationResults: {
            warningMessages: [],
            errorMessages: [
              {
                code: 'publicKey_QRCODE_INVALID',
                category: 'QRCODE_VALIDATION',
                message: 'ECDSA Public Key does not match with qr code ECDSA public key',
              },
              {
                code: 'certificate-permissions',
                category: 'CERTIFICATE_ERRORS',
                message: 'Certificate is not allowed to report this document',
              },
            ],
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = new ZatcaApiClient({
      environment: 'sandbox',
      sandboxUrl: 'https://sandbox.example.test',
      timeout: 1000,
    });

    const result = await client.submitForReporting(
      { binarySecurityToken: 'token', secret: 'secret' },
      { invoiceHash: 'hash', uuid: 'uuid', invoice: 'base64' },
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('publicKey_QRCODE_INVALID,certificate-permissions');
    expect(result.alerts).toHaveLength(2);
    expect(result.alerts?.[0]).toEqual({
      severity: 'error',
      code: 'publicKey_QRCODE_INVALID',
      category: 'QRCODE_VALIDATION',
      message: 'ECDSA Public Key does not match with qr code ECDSA public key',
    });

    await expect(
      client.submitForReportingOrThrow(
        { binarySecurityToken: 'token', secret: 'secret' },
        { invoiceHash: 'hash', uuid: 'uuid', invoice: 'base64' },
      ),
    ).rejects.toBeInstanceOf(ZatcaError);
  });
});
