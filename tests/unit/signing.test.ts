import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { generateInvoiceXml, signInvoice } from '../../src/index.js';

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

function testInvoiceXml(): string {
  return generateInvoiceXml({
    invoiceNumber: 'INV-SIGN-001',
    uuid: crypto.randomUUID(),
    issueDate: '2026-01-01',
    issueTime: '12:00:00',
    invoiceTypeCode: '388',
    invoiceTypeCodeName: '0200000',
    profileId: 'reporting:1.0',
    currencyCode: 'SAR',
    supplier: {
      nameAr: 'شركة نموذجية',
      nameEn: 'Test Company Ltd',
      vatNumber: '300000000000003',
      address: {
        street: 'King Fahd Road',
        building: '123',
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
    previousInvoiceHash: '',
  });
}

function qrData() {
  return {
    sellerName: 'شركة نموذجية',
    vatNumber: '300000000000003',
    timestamp: '2026-01-01T12:00:00',
    totalWithVat: '115.00',
    vatTotal: '15.00',
    certificateSignature: '',
  };
}

describe('invoice signing certificate checks', () => {
  test('rejects private keys that do not match a decodable certificate', () => {
    let privateKey: string;
    try {
      ({ privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'secp256k1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }));
    } catch {
      ({ privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }));
    }

    expect(() =>
      signInvoice({
        xml: testInvoiceXml(),
        privateKeyPem: privateKey,
        certificatePem: TEST_CERT,
        qrData: qrData(),
      }),
    ).toThrow('Private key does not match the supplied CSID certificate');
  });

  test('signs when private key matches the certificate', () => {
    const signed = signInvoice({
      xml: testInvoiceXml(),
      privateKeyPem: TEST_PRIVATE_KEY,
      certificatePem: TEST_CERT,
      qrData: qrData(),
    });

    expect(signed.signedXml).toContain('<ds:Signature');
    expect(signed.signedXml).toContain('<cbc:ID>QR</cbc:ID>');
    expect(signed.invoiceHash).toBeTruthy();
  });
});
