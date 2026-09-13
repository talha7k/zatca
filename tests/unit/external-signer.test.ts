import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import { XmlCanonicalizer } from 'xmldsigjs';

import { generateInvoiceXml } from '../../src/index.js';
import {
  canonicalizeForHash,
  signInvoiceWithExternalSigner,
} from '../../src/signing/index.js';
import type { ExternalSignerInput } from '../../src/signing/index.js';

// Reuse the same fixtures as signing.test.ts (matching key + certificate pair)
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
    invoiceNumber: 'INV-EXT-SIGN-001',
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

/** Real DER signer: signs canonical SignedInfo bytes with node crypto (DER output). */
function makeDerSigner() {
  const seen: Buffer[] = [];
  const returned: string[] = [];
  const sign = async ({ canonicalSignedInfo }: ExternalSignerInput) => {
    const data = Buffer.from(canonicalSignedInfo);
    seen.push(data);
    const der = crypto.sign('sha256', data, TEST_PRIVATE_KEY);
    const signatureValue = der.toString('base64');
    returned.push(signatureValue);
    return { signatureValue, signatureEncoding: 'base64_der' as const };
  };
  return { sign, seen, returned };
}

/** Canonicalize the ds:SignedInfo embedded in a signed XML document. */
function canonicalEmbeddedSignedInfo(signedXml: string): string {
  const match = signedXml.match(/<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/);
  if (!match) throw new Error('signed XML does not contain ds:SignedInfo');
  const doc = new DOMParser().parseFromString(match[0], 'text/xml');
  return new XmlCanonicalizer(false, false).Canonicalize(doc) as string;
}

/** Signs a fresh test invoice through a plain async callback signer. */
async function signWithCallbackSigner() {
  const { sign, seen, returned } = makeDerSigner();
  const result = await signInvoiceWithExternalSigner({
    xml: testInvoiceXml(),
    certificatePem: TEST_CERT,
    qrData: qrData(),
    signer: sign,
  });
  return { result, seen, returned };
}

describe('signInvoiceWithExternalSigner · signer result validation', () => {
  test('rejects base64_ieee_p1363 signer results', async () => {
    const promise = signInvoiceWithExternalSigner({
      xml: testInvoiceXml(),
      certificatePem: TEST_CERT,
      qrData: qrData(),
      signer: async () => ({
        signatureValue: Buffer.alloc(64, 1).toString('base64'),
        signatureEncoding: 'base64_ieee_p1363',
      }),
    });

    await expect(promise).rejects.toThrow(
      'External signer returned base64_ieee_p1363, but this XMLDSig path currently requires base64_der. ' +
      'TODO: convert Web Crypto raw P1363 signatures to DER before using this signer.',
    );
  });
});

describe('signInvoiceWithExternalSigner · DER signing via async callback', () => {
  test('receives exactly one canonical SignedInfo payload from the callback signer', async () => {
    const { seen } = await signWithCallbackSigner();

    // The signer received exactly one canonical SignedInfo payload
    expect(seen).toHaveLength(1);
    const signedInfoInput = seen[0].toString('utf8');
    expect(signedInfoInput.startsWith('<ds:SignedInfo')).toBe(true);
    expect(signedInfoInput.endsWith('</ds:SignedInfo>')).toBe(true);
  });

  test('embeds the returned DER signature as ds:SignatureValue', async () => {
    const { result, returned } = await signWithCallbackSigner();

    // 1. The embedded ds:SignatureValue equals the DER signature the callback returned
    const signatureValues = result.signedXml.match(
      /<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/,
    );
    expect(signatureValues).toBeTruthy();
    const embeddedSignature = signatureValues![1];
    expect(embeddedSignature).toBe(returned[0]);
  });

  test('embeds the QR AdditionalDocumentReference when qrData is provided', async () => {
    const { result } = await signWithCallbackSigner();

    // 2. The QR AdditionalDocumentReference is embedded when qrData is provided
    expect(result.signedXml).toContain('<cac:AdditionalDocumentReference>');
    expect(result.signedXml).toContain('<cbc:ID>QR</cbc:ID>');
    expect(result.signedXml).toContain('mimeCode="text/plain"');
  });

  test('hashes the canonicalized signed XML into invoiceHash', async () => {
    const { result } = await signWithCallbackSigner();

    // 3. invoiceHash is the base64 hash of the canonicalized signed XML
    //    (mirrors the final-hash re-encode loop)
    expect(result.invoiceHash).toBe(canonicalizeForHash(result.signedXml).hashBase64);
  });

  test('produces a DER signature that verifies against the certificate public key', async () => {
    const { result, returned } = await signWithCallbackSigner();

    // 4. The returned DER signature verifies against the canonical SignedInfo
    //    embedded in the document — with the certificate public key
    const canonicalSignedInfo = canonicalEmbeddedSignedInfo(result.signedXml);
    const certificateKey = new crypto.X509Certificate(TEST_CERT).publicKey;
    expect(
      crypto.verify(
        'sha256',
        Buffer.from(canonicalSignedInfo, 'utf8'),
        certificateKey,
        Buffer.from(returned[0], 'base64'),
      ),
    ).toBe(true);
  });
});

describe('signInvoiceWithExternalSigner · signer object form', () => {
  test('accepts a signer object with algorithm ECDSA_SHA256', async () => {
    const { sign } = makeDerSigner();
    const result = await signInvoiceWithExternalSigner({
      xml: testInvoiceXml(),
      certificatePem: TEST_CERT,
      qrData: qrData(),
      signer: { algorithm: 'ECDSA_SHA256', sign },
    });

    const signatureValue = result.signedXml.match(
      /<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/,
    )?.[1];
    expect(signatureValue).toBeTruthy();
    const certificateKey = new crypto.X509Certificate(TEST_CERT).publicKey;
    expect(
      crypto.verify(
        'sha256',
        Buffer.from(canonicalEmbeddedSignedInfo(result.signedXml), 'utf8'),
        certificateKey,
        Buffer.from(signatureValue!, 'base64'),
      ),
    ).toBe(true);
    expect(result.invoiceHash).toBe(canonicalizeForHash(result.signedXml).hashBase64);
  });
});
