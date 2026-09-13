import { describe, expect, test } from 'bun:test';
import {
  isCreditNoteData,
  submitInvoice,
  signInvoice,
  verifySignature,
  validateCredentials,
  validateApiConfig,
  ZatcaError,
} from '../../src/index.js';
import { DEFAULT_RETRY_BACKOFF_MS, DEFAULT_RETRY_MAX, isRetryableZatcaEffectError } from '../../src/effect/schedule.js';
import { DEFAULT_ZATCA_TIMEOUT_MS } from '../../src/effect/http.js';
import { canonicalizeXml, concatBytes, buildSdkSignedPropertiesDigestXml } from '../../src/signing/shared.js';
import { signComplianceInvoice } from '../../src/compliance/index.js';
import { extractPublicKey } from '../../src/certificate/index.js';
import { createTestInvoice, createTestCreditNote } from '../integration/fixtures.js';
import { generateInvoiceXml } from '../../src/xml/index.js';

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

describe('verifySignature', () => {
  const publicKeyPem = extractPublicKey(TEST_CERT);

  test('accepts a document signed by the matching key', () => {
    const { signedXml } = signInvoice({
      xml: generateInvoiceXml(createTestInvoice()),
      privateKeyPem: TEST_PRIVATE_KEY,
      certificatePem: TEST_CERT,
    });
    expect(verifySignature(signedXml, publicKeyPem)).toBe(true);
  });

  test('rejects a tampered document', () => {
    const { signedXml } = signInvoice({
      xml: generateInvoiceXml(createTestInvoice()),
      privateKeyPem: TEST_PRIVATE_KEY,
      certificatePem: TEST_CERT,
    });
    // The signature covers the canonical SignedInfo (incl. DigestValue) —
    // tampering with the digest must break verification.
    const tampered = signedXml.replace(
      /(<ds:DigestValue>)[^<]+/,
      '$1AAAA',
    );
    expect(verifySignature(tampered, publicKeyPem)).toBe(false);
  });
});

describe('validateCredentials / validateApiConfig', () => {
  test('validateCredentials rejects missing token then missing secret', () => {
    expect(() => validateCredentials({ binarySecurityToken: '', secret: 'x' })).toThrow(ZatcaError);
    expect(() => validateCredentials({ binarySecurityToken: 'tok', secret: '' })).toThrow(ZatcaError);
    expect(() => validateCredentials({ binarySecurityToken: 'tok', secret: 'sec' })).not.toThrow();
  });

  test('validateApiConfig enforces the environment enum', () => {
    expect(() => validateApiConfig({ environment: 'staging' } as never)).toThrow(/environment/);
    expect(() => validateApiConfig({ environment: 'production' } as never)).not.toThrow();
    expect(() => validateApiConfig({ environment: 'sandbox' } as never)).not.toThrow();
  });
});

describe('isCreditNoteData', () => {
  test('detects credit notes by any of their distinguishing fields', () => {
    const cn = createTestCreditNote();
    expect(isCreditNoteData(cn)).toBe(true);
    expect(isCreditNoteData(createTestInvoice())).toBe(false);
  });
});

describe('retry/timeout policy surface', () => {
  test('defaults match the ZATCA-documented backoff ladder', () => {
    expect(DEFAULT_RETRY_MAX).toBe(3);
    expect(DEFAULT_RETRY_BACKOFF_MS).toEqual([5000, 30000, 300000]);
    expect(DEFAULT_ZATCA_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test('isRetryableZatcaEffectError: connection/timeout retry, validation does not', async () => {
    const { ZatcaConnectionError, ZatcaTimeoutError, ZatcaValidationError } = await import('../../src/effect/errors.js');
    const diagnostics = { warnings: [], alerts: [] };
    expect(isRetryableZatcaEffectError(new ZatcaConnectionError({ message: 'x' }))).toBe(true);
    expect(isRetryableZatcaEffectError(new ZatcaTimeoutError({ message: 'x' }))).toBe(true);
    expect(isRetryableZatcaEffectError(new ZatcaValidationError({ message: 'x', diagnostics }))).toBe(false);
  });
});

describe('signing/shared exports', () => {
  test('concatBytes merges in order', () => {
    const merged = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]));
    expect([...merged]).toEqual([1, 2, 3]);
  });

  test('canonicalizeXml normalizes attributes and is deterministic', () => {
    const once = canonicalizeXml('<a xmlns="urn:x"><b>1</b></a>');
    expect(canonicalizeXml('<a  xmlns="urn:x" ><b>1</b></a>')).toBe(once);
    expect(once).toContain('xmlns="urn:x"');
  });

  test('buildSdkSignedPropertiesDigestXml produces a stable signed-properties skeleton', () => {
    const xml = buildSdkSignedPropertiesDigestXml(
      { digestValue: 'DIGEST', issuerName: 'CN=testca', serialNumber: '7' },
      '2026-09-13T00:00:00',
    );
    expect(xml).toContain('xades:SignedProperties');
    expect(xml).toContain('DIGEST');
    expect(xml).toContain('CN=testca');
  });
});

describe('signComplianceInvoice', () => {
  const supplier = createTestInvoice().supplier;

  test('builds and signs a compliance invoice in one call', () => {
    const result = signComplianceInvoice({
      checkType: 'SIMPLIFIED_INVOICE',
      supplier,
      privateKeyPem: TEST_PRIVATE_KEY,
      certificatePem: TEST_CERT,
    });
    expect(result.signedXml).toContain('<ds:SignatureValue');
    expect(result.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(result.base64SignedXml).not.toBe(result.signedXml);
  });

  test('propagates signing failures as ZatcaError', () => {
    expect(() =>
      signComplianceInvoice({
        checkType: 'SIMPLIFIED_INVOICE',
        supplier,
        privateKeyPem: 'not a key',
        certificatePem: TEST_CERT,
      }),
    ).toThrow(ZatcaError);
  });
});

describe('submitInvoice alias', () => {
  test('routes through the same pipeline as submitDocument (reporting happy path)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({
          reportingStatus: 'REPORTED',
          uuid: 'alias-test',
          invoiceHash: 'hash',
          validationResults: { errorMessages: [], warningMessages: [] },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;
      const result = await submitInvoice({
        invoice: createTestInvoice(),
        privateKeyPem: TEST_PRIVATE_KEY,
        certificatePem: TEST_CERT,
        certificateSignature: 'MAYCASoCASs=',
        credentials: { binarySecurityToken: 'tok', secret: 'sec' },
        apiConfig: { environment: 'sandbox', timeout: 1000, retryMax: 0 },
      });
      expect(result.success).toBe(true);
      expect(result.signedXml).toContain('<ds:SignatureValue');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
