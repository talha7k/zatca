/**
 * Effect orchestration tests
 *
 * Covers the Effect twins of the promise-based orchestration surface:
 * - ClearanceApi.clearInvoiceEffect
 * - ComplianceApi.requestCSIDEffect / verifyComplianceEffect / requestProductionCSIDEffect
 * - StatusApi.checkStatusEffect
 * - submitDocumentEffect / submitInvoiceEffect
 * - generateCSREffect / generateECDSAKeyPairEffect
 *
 * Twins must return the same data as the promise versions on happy paths,
 * map failures to the tagged errors (ZatcaApiError / ZatcaConnectionError /
 * ZatcaTimeoutError / ZatcaValidationError), and preserve the sequential
 * sign-then-post ordering of the submission pipeline.
 *
 * The network boundary is stubbed via globalThis.fetch (same approach as the
 * existing unit tests); no real HTTP traffic happens.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { Cause, Effect, Exit, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { ClearanceApi } from '../../src/api/clearance.js';
import { ComplianceApi } from '../../src/api/compliance.js';
import { StatusApi } from '../../src/api/status.js';
import {
  extractCertificateSignature,
  generateCSREffect,
  generateECDSAKeyPairEffect,
} from '../../src/certificate/generate.js';
import {
  submitDocument,
  submitDocumentEffect,
  submitInvoiceEffect,
  type SubmitOptions,
} from '../../src/invoice/submit.js';
import {
  ZatcaApiError,
  ZatcaConnectionError,
  ZatcaTimeoutError,
  ZatcaValidationError,
  toZatcaEffectError,
  type ZatcaEffectError,
} from '../../src/effect/errors.js';
import { createTestInvoice, TEST_CSR_PARAMS } from '../integration/fixtures.js';
import { ZatcaError } from '../../src/errors.js';
import type { ZatcaDocumentData } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const credentials = { binarySecurityToken: 'token', secret: 'secret' };
const apiConfig = {
  environment: 'sandbox' as const,
  sandboxUrl: 'https://sandbox.example.test',
  timeout: 1000,
  // No retries in unit tests: connection-failure paths must fail fast rather
  // than sleeping through the real 5s/30s/5min default backoff schedule.
  retryMax: 0,
};

const clearanceApi = new ClearanceApi(apiConfig);
const complianceApi = new ComplianceApi(apiConfig);
const statusApi = new StatusApi(apiConfig);

// ---------------------------------------------------------------------------
// Network stubs (mirror the existing unit-test approach)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}

function stubZatcaOk(body: unknown, status = 200): Array<CapturedCall> {
  const calls: Array<CapturedCall> = [];
  globalThis.fetch = (async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: String(url), method: init?.method, headers, body: String(init?.body ?? '') });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

function stubFetchFailure(error: Error): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as typeof fetch;
}

const connectionFailure = Object.assign(new Error('fetch failed'), {
  cause: { code: 'ECONNREFUSED', syscall: 'connect', hostname: 'sandbox.example.test' },
});

const timeoutFailure = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

// ---------------------------------------------------------------------------
// Effect helpers
// ---------------------------------------------------------------------------

async function failureOf(effect: Effect.Effect<unknown, ZatcaEffectError>): Promise<ZatcaEffectError> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error('expected the effect to fail, but it succeeded');
  }
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
}

// ---------------------------------------------------------------------------
// submitDocumentEffect fixtures
// ---------------------------------------------------------------------------

const reportingBody = {
  reportingStatus: 'REPORTED',
  uuid: 'reported-invoice',
  invoiceHash: 'hash',
  validationResults: { errorMessages: [], warningMessages: [] },
};

function submitOptions(invoice: ZatcaDocumentData, overrides?: Partial<SubmitOptions>): SubmitOptions {
  return {
    invoice,
    privateKeyPem: TEST_PRIVATE_KEY,
    certificatePem: TEST_CERT,
    certificateSignature: extractCertificateSignature(TEST_CERT),
    credentials,
    apiConfig,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ClearanceApi.clearInvoiceEffect
// ---------------------------------------------------------------------------

describe('ClearanceApi.clearInvoiceEffect', () => {
  const request = { invoiceHash: 'abc-hash', uuid: 'uuid-clearance-1', invoice: 'aW52b2ljZQ==' };
  const acceptedBody = {
    acceptedInvoices: [{ uuid: 'uuid-clearance-1', invoiceHash: 'abc-hash', clearanceStatus: 'CLEARED' }],
  };

  test('returns the same data as the promise version and hits the clearance endpoint', async () => {
    const promiseCalls = stubZatcaOk(acceptedBody);
    const promiseResult = await clearanceApi.clearInvoice(credentials, request);

    const twinCalls = stubZatcaOk(acceptedBody);
    const twinResult = await Effect.runPromise(clearanceApi.clearInvoiceEffect(credentials, request));

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.success).toBe(true);
    expect(twinCalls.map((c) => c.url)).toEqual(promiseCalls.map((c) => c.url));
    expect(twinCalls[0].url).toBe('https://sandbox.example.test/invoices/clearance/single');
  });

  test('maps connection failures to ZatcaConnectionError and keeps the cause', async () => {
    stubFetchFailure(connectionFailure);
    const error = await failureOf(clearanceApi.clearInvoiceEffect(credentials, request));
    expect(error).toBeInstanceOf(ZatcaConnectionError);
    expect(error._tag).toBe('ZatcaConnectionError');
    expect(error.message).toContain('ZATCA API connection failed');
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.cause).toBeInstanceOf(ZatcaError);
  });

  test('maps aborted requests to ZatcaTimeoutError', async () => {
    stubFetchFailure(timeoutFailure);
    const error = await failureOf(clearanceApi.clearInvoiceEffect(credentials, request));
    expect(error).toBeInstanceOf(ZatcaTimeoutError);
    expect(error._tag).toBe('ZatcaTimeoutError');
    expect(error.message).toContain('timed out');
  });

  test('returns an unsuccessful result (not a typed failure) for unparseable bodies', async () => {
    const promiseCalls = stubZatcaOk('this is not json');
    const promiseResult = await clearanceApi.clearInvoice(credentials, request);

    const twinCalls = stubZatcaOk('this is not json');
    const twinResult = await Effect.runPromise(clearanceApi.clearInvoiceEffect(credentials, request));

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.success).toBe(false);
    expect(twinCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ComplianceApi twins
// ---------------------------------------------------------------------------

describe('ComplianceApi.requestCSIDEffect', () => {
  const csr = '-----BEGIN CERTIFICATE REQUEST-----\nabc\n-----END CERTIFICATE REQUEST-----';
  const csidBody = { binarySecurityToken: 'tok-1', secret: 'sec-1', requestID: 'req-9' };

  test('returns the same ACCEPTED data as the promise version', async () => {
    const promiseCalls = stubZatcaOk(csidBody);
    const promiseResult = await complianceApi.requestCSID(csr, '123456');

    const twinCalls = stubZatcaOk(csidBody);
    const twinResult = await Effect.runPromise(complianceApi.requestCSIDEffect(csr, '123456'));

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.status).toBe('ACCEPTED');
    expect(twinResult.requestId).toBe('req-9');
    expect(twinCalls.map((c) => c.url)).toEqual(promiseCalls.map((c) => c.url));
    expect(twinCalls[0].headers['otp']).toBe('123456');
  });

  test('returns a REJECTED result (not a typed failure) for a missing CSR, like the promise version', async () => {
    const promiseResult = await complianceApi.requestCSID('');
    const twinResult = await Effect.runPromise(complianceApi.requestCSIDEffect(''));

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.status).toBe('REJECTED');
    expect(twinResult.error?.code).toBe('MISSING_CSR');
  });
});

describe('ComplianceApi.verifyComplianceEffect', () => {
  const verifyBody = {
    validationResults: {
      errorMessages: [{ message: 'hash mismatch' }],
      warningMessages: [{ message: 'minor issue' }],
    },
  };

  test('returns the same formatted messages as the promise version', async () => {
    const promiseCalls = stubZatcaOk(verifyBody);
    const promiseResult = await complianceApi.verifyCompliance(credentials, 'h', 'u', 'i');

    const twinCalls = stubZatcaOk(verifyBody);
    const twinResult = await Effect.runPromise(complianceApi.verifyComplianceEffect(credentials, 'h', 'u', 'i'));

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.valid).toBe(false);
    expect(twinResult.messages).toEqual(['ERROR: hash mismatch', 'WARNING: minor issue']);
    expect(twinCalls.map((c) => c.url)).toEqual(promiseCalls.map((c) => c.url));
  });

  test('maps connection failures to ZatcaConnectionError', async () => {
    stubFetchFailure(connectionFailure);
    const error = await failureOf(complianceApi.verifyComplianceEffect(credentials, 'h', 'u', 'i'));
    expect(error._tag).toBe('ZatcaConnectionError');
  });
});

describe('ComplianceApi.requestProductionCSIDEffect', () => {
  const productionBody = { binarySecurityToken: 'prod-tok', secret: 'prod-sec', requestId: 'prod-rid' };

  test('returns the same ACCEPTED data as the promise version', async () => {
    const promiseCalls = stubZatcaOk(productionBody);
    const promiseResult = await complianceApi.requestProductionCSID(credentials, 'compliance-rid');

    const twinCalls = stubZatcaOk(productionBody);
    const twinResult = await Effect.runPromise(
      complianceApi.requestProductionCSIDEffect(credentials, 'compliance-rid'),
    );

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.status).toBe('ACCEPTED');
    expect(twinCalls.map((c) => c.url)).toEqual(promiseCalls.map((c) => c.url));
    expect(twinCalls[0].body).toContain('compliance-rid');
  });

  test('returns a REJECTED result (not a typed failure) on non-2xx, like the promise version', async () => {
    const rejectedBody = { errors: [{ code: '401', category: 'HTTP-Errors', message: 'unauthorized' }] };
    const promiseResult = await (async () => {
      stubZatcaOk(rejectedBody, 401);
      return complianceApi.requestProductionCSID(credentials, 'compliance-rid');
    })();

    stubZatcaOk(rejectedBody, 401);
    const twinResult = await Effect.runPromise(
      complianceApi.requestProductionCSIDEffect(credentials, 'compliance-rid'),
    );

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.status).toBe('REJECTED');
  });
});

// ---------------------------------------------------------------------------
// StatusApi.checkStatusEffect
// ---------------------------------------------------------------------------

describe('StatusApi.checkStatusEffect', () => {
  const statusBody = {
    status: 'CLEARED',
    validationResults: {
      status: 'Cleared',
      errorMessages: [],
      warningMessages: [],
      infoMessages: [{ code: 'info-1', message: 'all good' }],
    },
    clearanceStatus: 'CLEARED',
  };

  test('returns the same parsed status as the promise version', async () => {
    const promiseCalls = stubZatcaOk(statusBody);
    const promiseResult = await statusApi.checkStatus(credentials, 'uuid-status-1');

    const twinCalls = stubZatcaOk(statusBody);
    const twinResult = await Effect.runPromise(statusApi.checkStatusEffect(credentials, 'uuid-status-1'));

    expect(twinResult).toEqual(promiseResult);
    expect(twinResult.status).toBe('CLEARED');
    expect(twinResult.clearanceStatus).toBe('CLEARED');
    expect(twinCalls[0].url).toBe('https://sandbox.example.test/invoices/status/uuid-status-1');
  });

  test('maps a 404 to ZatcaApiError', async () => {
    stubZatcaOk({ message: 'not found' }, 404);
    const error = await failureOf(statusApi.checkStatusEffect(credentials, 'uuid-missing'));
    expect(error).toBeInstanceOf(ZatcaApiError);
    expect(error._tag).toBe('ZatcaApiError');
    expect(error.message).toContain('Invoice not found');
  });

  test('maps unparseable status bodies to ZatcaApiError', async () => {
    stubZatcaOk('@@not json@@');
    const error = await failureOf(statusApi.checkStatusEffect(credentials, 'uuid-status-1'));
    expect(error._tag).toBe('ZatcaApiError');
    expect(error.message).toContain('Failed to parse invoice status response');
  });
});

// ---------------------------------------------------------------------------
// submitDocumentEffect / submitInvoiceEffect
// ---------------------------------------------------------------------------

describe('submitDocumentEffect · promise-twin happy paths', () => {
  test('returns the same data as the promise version on the reporting happy path', async () => {
    const invoice = createTestInvoice();

    const promiseCalls = stubZatcaOk(reportingBody);
    const promiseResult = await submitDocument(submitOptions(invoice));

    const twinCalls = stubZatcaOk(reportingBody);
    const twinResult = await Effect.runPromise(submitDocumentEffect(submitOptions(invoice)));

    expect(twinResult.success).toBe(true);
    expect(twinResult.success).toBe(promiseResult.success);
    expect(twinResult.invoiceHash).toBe(promiseResult.invoiceHash);
    expect(twinResult.zatcaResult).toEqual(promiseResult.zatcaResult);
    expect(twinResult.newHashChainState?.lastHash).toBe(promiseResult.newHashChainState?.lastHash);
    expect(twinResult.newHashChainState?.counter).toBe(promiseResult.newHashChainState?.counter);
    expect(twinResult.qrCodeBase64.length).toBeGreaterThan(0);
    expect(promiseResult.qrCodeBase64.length).toBeGreaterThan(0);
    expect(twinCalls.map((c) => c.url)).toEqual(promiseCalls.map((c) => c.url));
    expect(twinCalls[0].url).toBe('https://sandbox.example.test/invoices/reporting/single');
  });

  test('runs sequentially: signs the document before posting it', async () => {
    const invoice = createTestInvoice();
    const calls = stubZatcaOk(reportingBody);

    const result = await Effect.runPromise(submitDocumentEffect(submitOptions(invoice)));

    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0].body);
    expect(sent.invoiceHash).toBe(result.invoiceHash);
    expect(sent.uuid).toBe(invoice.uuid);
    expect(Buffer.from(sent.invoice, 'base64').toString('utf8')).toBe(result.signedXml);
    expect(result.signedXml).toContain('SignatureValue');
  });
});

describe('submitDocumentEffect · routing & hash chain', () => {
  test('routes standard invoices to the clearance endpoint and matches the alias twin', async () => {
    const invoice = createTestInvoice({
      invoiceTypeCodeName: '0100000',
      profileId: 'clearance:1.0',
      customer: { name: 'VAT Buyer', vatNumber: '300000000000003' },
    });
    const acceptedBody = {
      acceptedInvoices: [{ uuid: invoice.uuid, invoiceHash: 'hash', clearanceStatus: 'CLEARED' }],
    };

    const pipelineCalls = stubZatcaOk(acceptedBody);
    const pipelineResult = await Effect.runPromise(submitDocumentEffect(submitOptions(invoice)));

    const aliasCalls = stubZatcaOk(acceptedBody);
    const aliasResult = await Effect.runPromise(submitInvoiceEffect(submitOptions(invoice)));

    expect(pipelineCalls[0].url).toBe('https://sandbox.example.test/invoices/clearance/single');
    expect(pipelineResult.success).toBe(true);
    expect(aliasResult.invoiceHash).toBe(pipelineResult.invoiceHash);
    expect(aliasResult.success).toBe(pipelineResult.success);
    expect(aliasCalls[0].url).toBe(pipelineCalls[0].url);
  });

  test('advances the hash chain from the provided state only on success', async () => {
    const invoice = createTestInvoice();
    const priorState = {
      lastHash: 'prior-hash',
      lastUuid: 'prior-uuid',
      counter: 7,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const successCalls = stubZatcaOk(reportingBody);
    const successResult = await Effect.runPromise(
      submitDocumentEffect(submitOptions(invoice, { hashChainState: priorState })),
    );
    expect(successCalls).toHaveLength(1);
    expect(successResult.newHashChainState?.counter).toBe(8);
    expect(successResult.newHashChainState?.lastHash).toBe(successResult.invoiceHash);
    expect(successResult.newHashChainState?.lastUuid).toBe(invoice.uuid);

    const rejectedBody = {
      reportingStatus: 'NOT_REPORTED',
      validationResults: {
        errorMessages: [{ code: 'some-error', category: 'CAT', message: 'rejected' }],
        warningMessages: [],
      },
    };
    stubZatcaOk(rejectedBody);
    const rejectedResult = await Effect.runPromise(
      submitDocumentEffect(submitOptions(invoice, { hashChainState: priorState })),
    );
    expect(rejectedResult.success).toBe(false);
    expect(rejectedResult.newHashChainState).toBeUndefined();
  });
});

describe('submitDocumentEffect · failure mapping', () => {
  test('maps missing input to ZatcaValidationError', async () => {
    const invoice = createTestInvoice();
    const error = await failureOf(
      submitDocumentEffect(submitOptions(invoice, { privateKeyPem: '' })),
    );
    expect(error).toBeInstanceOf(ZatcaValidationError);
    expect(error._tag).toBe('ZatcaValidationError');
    expect(error.message).toContain('privateKeyPem');
  });

  test('maps invalid document data to ZatcaValidationError before any HTTP call', async () => {
    const invoice = createTestInvoice({ invoiceNumber: '' });
    const error = await failureOf(submitDocumentEffect(submitOptions(invoice)));
    expect(error._tag).toBe('ZatcaValidationError');
    expect(error.message).toContain('invoiceNumber is required');
  });

  test('maps submit-stage connection failures to ZatcaConnectionError', async () => {
    const invoice = createTestInvoice();
    stubFetchFailure(connectionFailure);
    const error = await failureOf(submitDocumentEffect(submitOptions(invoice)));
    expect(error._tag).toBe('ZatcaConnectionError');
  });

  test('introduces no artificial delays: completes under the TestClock without advancing it', async () => {
    const invoice = createTestInvoice();
    stubZatcaOk(reportingBody);

    const result = await Effect.runPromise(
      Effect.provide(submitDocumentEffect(submitOptions(invoice)), TestClock.layer()),
    );

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Certificate twins
// ---------------------------------------------------------------------------

describe('generateCSREffect', () => {
  test('produces a parseable CSR bundle like the sync version', async () => {
    const result = await Effect.runPromise(generateCSREffect(TEST_CSR_PARAMS, 'sandbox'));

    expect(result.csr).toContain('-----BEGIN CERTIFICATE REQUEST-----');
    expect(result.privateKey).toContain('PRIVATE KEY');
    expect(result.publicKey).toContain('PUBLIC KEY');
    crypto.createPrivateKey(result.privateKey);
    crypto.createPublicKey(result.publicKey);
  });

  test('maps invalid CSR params to ZatcaValidationError', async () => {
    const error = await failureOf(generateCSREffect({ ...TEST_CSR_PARAMS, vatNumber: '' }));
    expect(error).toBeInstanceOf(ZatcaValidationError);
    expect(error._tag).toBe('ZatcaValidationError');
    expect(error.message).toContain('vatNumber');
  });
});

describe('generateECDSAKeyPairEffect', () => {
  test('returns a usable key pair', async () => {
    const pair = await Effect.runPromise(generateECDSAKeyPairEffect());
    const keyObject = crypto.createPrivateKey(pair.privateKey);
    expect(keyObject.type).toBe('private');
    crypto.createPublicKey(pair.publicKey);
  });
});

// ---------------------------------------------------------------------------
// Error classification helper
// ---------------------------------------------------------------------------

describe('toZatcaEffectError', () => {
  test('classifies unknown errors as ZatcaApiError', () => {
    const error = toZatcaEffectError(new Error('mysterious'));
    expect(error._tag).toBe('ZatcaApiError');
    expect(error.message).toContain('mysterious');
  });
});
