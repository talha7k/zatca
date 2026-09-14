import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { signInvoiceWithExternalSignerEffect } from '../../src/signing/index.js';
import { signBrowserInvoiceWithExternalSignerEffect } from '../../src/browser/index.js';
import { runZatcaEffect, isZatcaEffectError } from '../../src/effect/errors.js';
import { ZatcaError } from '../../src/index.js';
import { createTestInvoice } from '../integration/fixtures.js';
import { generateInvoiceXml } from '../../src/xml/index.js';
import type { ZatcaExternalSignerCallback } from '../../src/signing/index.js';

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
void TEST_PRIVATE_KEY;

/** Node-crypto signer returning base64 DER (same contract as external-signer tests). */
const base64DerSigner: ZatcaExternalSignerCallback = async (input) => {
  const { sign, createPrivateKey } = await import('node:crypto');
  const key = createPrivateKey(TEST_PRIVATE_KEY);
  const der = sign('sha256', Buffer.from(input.canonicalSignedInfo), key);
  return { signatureValue: der.toString('base64'), signatureEncoding: 'base64_der' };
};

const invoice = createTestInvoice();

async function failingError(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
  return Effect.runPromise(Effect.flip(effect));
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('signInvoiceWithExternalSignerEffect', () => {
  test('returns a signed result identical in shape to the promise version', async () => {
    const result = await Effect.runPromise(signInvoiceWithExternalSignerEffect({
      xml: generateInvoiceXml(invoice),
      certificatePem: TEST_CERT,
      signer: base64DerSigner,
    }));
    expect(result.signedXml).toContain('<ds:SignatureValue');
    expect(result.invoiceHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test('maps a base64_ieee_p1363 signer result to a tagged error', async () => {
    const error = await failingError(signInvoiceWithExternalSignerEffect({
      xml: generateInvoiceXml(invoice),
      certificatePem: TEST_CERT,
      signer: async () => ({ signatureValue: 'AAAA', signatureEncoding: 'base64_ieee_p1363' as const }),
    }));
    expect(isZatcaEffectError(error)).toBe(true);
  });

  test('promise wrapper still throws the legacy ZatcaError with the DER message', async () => {
    const error = await rejectionOf(runZatcaEffect(signInvoiceWithExternalSignerEffect({
      xml: generateInvoiceXml(invoice),
      certificatePem: TEST_CERT,
      signer: async () => ({ signatureValue: 'AAAA', signatureEncoding: 'base64_ieee_p1363' as const }),
    })));
    expect(error).toBeInstanceOf(ZatcaError);
    expect((error as ZatcaError).message).toContain('base64_der');
  });
});

describe('signBrowserInvoiceWithExternalSignerEffect', () => {
  test('maps missing-UBLExtensions input to a tagged error (legacy ZatcaError via wrapper)', async () => {
    const error = await rejectionOf(runZatcaEffect(signBrowserInvoiceWithExternalSignerEffect({
      xml: '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>',
      certificatePem: TEST_CERT,
      certificateInfo: { issuerName: 'CN=testca', serialNumber: '1' },
      qrPublicKey: 'A0F3',
      // Browser signer API takes the ZatcaExternalSigner object (not the bare callback).
      signer: { sign: base64DerSigner },
    })));
    expect(error).toBeInstanceOf(ZatcaError);
  });
});
