import { beforeAll, describe, expect, test } from 'bun:test';
import crypto from 'crypto';

import { ZatcaError, ZatcaErrorCode } from '../../src/errors.js';
import type { QRInvoiceData } from '../../src/signing/index.js';
import { generateInvoiceXml } from '../../src/index.js';
import {
  assertExternalSigner,
  createExternalSignerUnavailableError,
  createWebCryptoExternalSigner,
  ieeeP1363ToDerSignature,
  signBrowserInvoiceWithExternalSigner,
} from '../../src/browser/index.js';

// ---------------------------------------------------------------------------
// Fixtures (matching key/certificate pair reused from the signing suite)
// ---------------------------------------------------------------------------

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

function qrData(): QRInvoiceData {
  return {
    sellerName: 'شركة نموذجية',
    vatNumber: '300000000000003',
    timestamp: '2026-01-01T12:00:00',
    totalWithVat: '115.00',
    vatTotal: '15.00',
    certificateSignature: 'MEUCIQDtestCertificateSignatureBase64Value==',
  };
}

function testInvoiceXml(): string {
  return generateInvoiceXml({
    invoiceNumber: 'INV-BROWSER-001',
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

/** Generate a fresh WebCrypto ECDSA P-256 key pair. */
async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

/** Test-only reference DER encoder (independent of the implementation). */
function refDerEncodeInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) start++;
  const stripped = bytes.subarray(start);
  const pad = stripped[0] & 0x80 ? [0x00] : [];
  const value = new Uint8Array([...pad, ...stripped]);
  return new Uint8Array([0x02, value.length, ...value]);
}

function refDerSequence(parts: Uint8Array[]): Uint8Array {
  const contentLength = parts.reduce((sum, p) => sum + p.length, 0);
  const header = contentLength < 128
    ? [0x30, contentLength]
    : [0x30, 0x81, contentLength];
  const result = new Uint8Array(header.length + contentLength);
  result.set(header, 0);
  let offset = header.length;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Parse a DER ECDSA signature back into fixed-width r || s (test-side only). */
function parseDerToP1363(der: Uint8Array, halfLength: number): Uint8Array {
  expect(der[0]).toBe(0x30);
  let contentLength = der[1];
  let offset = 2;
  if (contentLength & 0x80) {
    const numLenBytes = contentLength & 0x7f;
    contentLength = Number(BigInt.asUintN(64, 0n) + der.slice(offset, offset + numLenBytes).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n));
    offset += numLenBytes;
  }
  const integers: Uint8Array[] = [];
  const end = offset + contentLength;
  while (offset < end) {
    expect(der[offset]).toBe(0x02);
    const intLen = der[offset + 1];
    integers.push(der.slice(offset + 2, offset + 2 + intLen));
    offset += 2 + intLen;
  }
  expect(integers).toHaveLength(2);
  const toFixed = (int: Uint8Array): Uint8Array => {
    const value = int.length > halfLength ? int.subarray(1) : int; // drop sign pad
    const result = new Uint8Array(halfLength).fill(0x00);
    result.set(value, halfLength - value.length);
    return result;
  };
  return new Uint8Array([...toFixed(integers[0]), ...toFixed(integers[1])]);
}

function expectZatcaSignError(action: () => unknown, message: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZatcaError);
  const zatcaError = caught as ZatcaError;
  expect(zatcaError.message).toBe(message);
  expect(zatcaError.code).toBe(ZatcaErrorCode.SIGN_ERROR);
}

/** Extract and decode the QR TLV payload embedded in the signed XML. */
function embeddedQrTags(signedXml: string): Map<number, Buffer> {
  const qrMatch = signedXml.match(
    /<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([A-Za-z0-9+/=]+)<\/cbc:EmbeddedDocumentBinaryObject>/,
  );
  expect(qrMatch).not.toBeNull();
  const tlv = Buffer.from(qrMatch![1], 'base64');
  const tags = new Map<number, Buffer>();
  let offset = 0;
  while (offset < tlv.length) {
    const tag = tlv[offset++];
    let length = tlv[offset++];
    if (length & 0x80) {
      const numLenBytes = length & 0x7f;
      length = tlv.subarray(offset, offset + numLenBytes).reduce((acc, b) => acc * 256 + b, 0);
      offset += numLenBytes;
    }
    tags.set(tag, tlv.subarray(offset, offset + length));
    offset += length;
  }
  return tags;
}

// ---------------------------------------------------------------------------
// createExternalSignerUnavailableError
// ---------------------------------------------------------------------------

describe('createExternalSignerUnavailableError', () => {
  test('returns ZatcaError with exact spec message and SIGN_ERROR code', () => {
    const error = createExternalSignerUnavailableError();
    expect(error).toBeInstanceOf(ZatcaError);
    expect(error.message).toBe(
      'Browser external-signer XMLDSig support has not been wired yet. Use this package surface for non-exportable Web Crypto signer integration.',
    );
    expect(error.code).toBe(ZatcaErrorCode.SIGN_ERROR);
  });
});

// ---------------------------------------------------------------------------
// assertExternalSigner
// ---------------------------------------------------------------------------

describe('assertExternalSigner', () => {
  test('returns the signer unchanged for ECDSA_SHA256', () => {
    const signer = {
      algorithm: 'ECDSA_SHA256' as const,
      sign: async () => ({ signatureValue: 'AA==', signatureEncoding: 'base64_der' as const }),
    };
    expect(assertExternalSigner(signer)).toBe(signer);
  });

  test('rejects a signer without an algorithm (undefined)', () => {
    const signer = {
      sign: async () => ({ signatureValue: 'AA==', signatureEncoding: 'base64_der' as const }),
    };
    expectZatcaSignError(
      () => assertExternalSigner(signer as Parameters<typeof assertExternalSigner>[0]),
      'Unsupported external signer algorithm: undefined',
    );
  });

  test('rejects a non-ECDSA_SHA256 algorithm', () => {
    const signer = {
      algorithm: 'RSA_SHA256',
      sign: async () => ({ signatureValue: 'AA==', signatureEncoding: 'base64_der' as const }),
    };
    expectZatcaSignError(
      () => assertExternalSigner(signer as Parameters<typeof assertExternalSigner>[0]),
      'Unsupported external signer algorithm: RSA_SHA256',
    );
  });
});

// ---------------------------------------------------------------------------
// ieeeP1363ToDerSignature
// ---------------------------------------------------------------------------

describe('ieeeP1363ToDerSignature · invalid input', () => {
  test('throws ZatcaError SIGN_ERROR on empty input', () => {
    expectZatcaSignError(
      () => ieeeP1363ToDerSignature(new Uint8Array(0)),
      'Invalid IEEE P1363 ECDSA signature length: 0',
    );
  });

  test('throws ZatcaError SIGN_ERROR on odd raw byte length', () => {
    expectZatcaSignError(
      () => ieeeP1363ToDerSignature(new Uint8Array([0x01, 0x02, 0x03])),
      'Invalid IEEE P1363 ECDSA signature length: 3',
    );
  });
});

describe('ieeeP1363ToDerSignature · DER conversion', () => {
  test('strips leading zeroes and pads high-bit halves (deterministic vector)', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0xff; // high bit set → needs 0x00 sign pad
    for (let i = 1; i < 32; i++) raw[i] = 0x01;
    // s half: leading zeroes then 0x7f (high bit clear)
    raw[32] = 0x00;
    raw[33] = 0x00;
    raw[34] = 0x7f;
    for (let i = 35; i < 64; i++) raw[i] = 0x02;

    const expected = refDerSequence([
      refDerEncodeInteger(raw.subarray(0, 32)),
      refDerEncodeInteger(raw.subarray(32)),
    ]);
    const der = ieeeP1363ToDerSignature(raw);
    expect(Buffer.from(der).toString('hex')).toBe(Buffer.from(expected).toString('hex'));
    // structural: SEQUENCE, two INTEGERs, 0x00 sign pad present for r
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02);
    expect(der[4]).toBe(0x00);
  });

  test('round-trips a real WebCrypto P-256 signature (node crypto verifies DER)', async () => {
    const { privateKey, publicKey } = await generateP256KeyPair();
    const data = new TextEncoder().encode('zatca browser ieee p1363 to der vector');
    // Real WebCrypto signing produces raw IEEE-P1363 (r || s, 32+32 bytes)
    const raw = new Uint8Array(
      await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey, data),
    );
    expect(raw).toHaveLength(64);

    const der = ieeeP1363ToDerSignature(raw);
    expect(der[0]).toBe(0x30);

    // DER → P1363 round-trip must recover the exact raw signature
    expect(Buffer.from(parseDerToP1363(der, 32)).toString('hex')).toBe(
      Buffer.from(raw).toString('hex'),
    );

    // node crypto must accept the converted DER as the same signature
    const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey('spki', publicKey));
    const nodeKey = crypto.createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
    expect(crypto.verify('sha256', Buffer.from(data), nodeKey, Buffer.from(der))).toBe(true);
  });

  test('real node ieee-p1363 signature converts to node-verifiable DER', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('zatca browser p1363 vector via node', 'utf8');
    const p1363 = crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(p1363).toHaveLength(64);
    const der = ieeeP1363ToDerSignature(new Uint8Array(p1363));
    expect(Buffer.from(parseDerToP1363(der, 32)).toString('hex')).toBe(p1363.toString('hex'));
    expect(crypto.verify('sha256', data, publicKey, Buffer.from(der))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createWebCryptoExternalSigner
// ---------------------------------------------------------------------------

describe('createWebCryptoExternalSigner', () => {
  test('exposes ECDSA_SHA256 algorithm', async () => {
    const { privateKey } = await generateP256KeyPair();
    const signer = createWebCryptoExternalSigner({ key: privateKey });
    expect(signer.algorithm).toBe('ECDSA_SHA256');
  });

  test('signs canonical bytes into base64 DER that node verifies', async () => {
    const { privateKey, publicKey } = await generateP256KeyPair();
    const signer = createWebCryptoExternalSigner({ key: privateKey });

    const canonicalSignedInfo = new TextEncoder().encode(
      '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/></ds:SignedInfo>',
    );
    const result = await signer.sign({
      algorithm: 'ECDSA_SHA256',
      canonicalSignedInfo,
      expectedSignatureEncoding: 'base64_der',
    });

    expect(result.signatureEncoding).toBe('base64_der');
    const der = Buffer.from(result.signatureValue, 'base64');
    expect(der[0]).toBe(0x30);

    const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey('spki', publicKey));
    const nodeKey = crypto.createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
    expect(crypto.verify('sha256', Buffer.from(canonicalSignedInfo), nodeKey, der)).toBe(true);
  });

  test('rejects a non-ECDSA_SHA256 input algorithm with ZatcaError', async () => {
    const { privateKey } = await generateP256KeyPair();
    const signer = createWebCryptoExternalSigner({ key: privateKey });
    let caught: unknown;
    try {
      await signer.sign({
        algorithm: 'RSA_SHA256' as 'ECDSA_SHA256',
        canonicalSignedInfo: new Uint8Array([1, 2, 3]),
        expectedSignatureEncoding: 'base64_der',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZatcaError);
    expect((caught as ZatcaError).message).toBe('Unsupported external signer algorithm: RSA_SHA256');
    expect((caught as ZatcaError).code).toBe(ZatcaErrorCode.SIGN_ERROR);
  });
});

// ---------------------------------------------------------------------------
// signBrowserInvoiceWithExternalSigner (smoke — XMLDSig path is wired in spec)
// ---------------------------------------------------------------------------

describe('signBrowserInvoiceWithExternalSigner · end-to-end', () => {
  let result: Awaited<ReturnType<typeof signBrowserInvoiceWithExternalSigner>>;
  let qrTags: Map<number, Buffer>;
  let qrPublicKey: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateP256KeyPair();
    qrPublicKey = Buffer.from(
      new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', publicKey)),
    ).toString('base64');

    const signer = createWebCryptoExternalSigner({ key: privateKey });
    result = await signBrowserInvoiceWithExternalSigner({
      xml: testInvoiceXml(),
      certificatePem: TEST_CERT,
      certificateInfo: { issuerName: 'CN=testca', serialNumber: '5aa919642' },
      qrData: qrData(),
      signer,
      qrPublicKey,
    });
    qrTags = embeddedQrTags(result.signedXml);
  });

  test('returns base64-shaped invoice hash, signature value and signed XML', () => {
    // Result shape
    expect(typeof result.signedXml).toBe('string');
    expect(result.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/); // 32 bytes base64
    expect(result.signatureValue).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test('embeds the XMLDSig signature structure with XAdES properties and the certificate', () => {
    // XMLDSig structure embedded
    expect(result.signedXml).toContain('<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">');
    expect(result.signedXml).toContain('<xades:SignedProperties');
    expect(result.signedXml).toContain('xadesSignedProperties');
    expect(result.signedXml).toContain(`<ds:X509Certificate>${TEST_CERT.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '')}</ds:X509Certificate>`);
    expect(result.signedXml).toContain(`<ds:DigestValue>${result.invoiceHash}</ds:DigestValue>`);
    expect(result.signedXml).toContain(`<ds:SignatureValue>${result.signatureValue}</ds:SignatureValue>`);
  });

  test('embeds a QR TLV whose tags 1, 6, 7 and 8 match the signing inputs and result', () => {
    // QR TLV embedded and Tags 6/7 consistent with the result
    for (const expectedTag of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(qrTags.has(expectedTag)).toBe(true);
    }
    expect(qrTags.get(6)!.toString('utf8')).toBe(result.invoiceHash);
    expect(qrTags.get(7)!.toString('utf8')).toBe(result.signatureValue);
    expect(qrTags.get(8)!.toString('base64')).toBe(qrPublicKey);
    expect(qrTags.get(1)!.toString('utf8')).toBe(qrData().sellerName);
  });
});

describe('signBrowserInvoiceWithExternalSigner · error handling', () => {
  test('rejects XML without an ext:UBLExtensions placeholder (wrapped ZatcaError)', async () => {
    const { privateKey } = await generateP256KeyPair();
    const signer = createWebCryptoExternalSigner({ key: privateKey });
    let caught: unknown;
    try {
      await signBrowserInvoiceWithExternalSigner({
        xml: '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cac:AdditionalDocumentReference/></Invoice>',
        certificatePem: TEST_CERT,
        certificateInfo: { issuerName: 'CN=testca', serialNumber: '5aa919642' },
        signer,
        qrPublicKey: 'A0F3',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZatcaError);
    expect((caught as ZatcaError).message).toBe(
      'Failed to sign browser invoice with external signer: Invoice XML must contain ext:UBLExtensions placeholder',
    );
    expect((caught as ZatcaError).code).toBe(ZatcaErrorCode.SIGN_ERROR);
  });

  test('propagates unsupported signer algorithm as-is (not double-wrapped)', async () => {
    const badSigner = {
      algorithm: 'RSA_SHA256',
      sign: async () => ({ signatureValue: 'AA==', signatureEncoding: 'base64_der' as const }),
    };
    let caught: unknown;
    try {
      await signBrowserInvoiceWithExternalSigner({
        xml: testInvoiceXml(),
        certificatePem: TEST_CERT,
        certificateInfo: { issuerName: 'CN=testca', serialNumber: '5aa919642' },
        qrData: qrData(),
        signer: badSigner as Parameters<typeof signBrowserInvoiceWithExternalSigner>[0]['signer'],
        qrPublicKey: 'A0F3',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZatcaError);
    expect((caught as ZatcaError).message).toBe('Unsupported external signer algorithm: RSA_SHA256');
  });
});
