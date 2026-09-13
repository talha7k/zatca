import { describe, expect, test } from 'bun:test';
import {
  ZatcaApiError,
  ZatcaConnectionError,
  ZatcaTimeoutError,
  ZatcaValidationError,
  isZatcaEffectError,
  toTaggedZatcaError,
  toZatcaError,
} from '../../src/effect/errors.js';
import { ZatcaError, ZatcaErrorCode } from '../../src/errors.js';

describe('toTaggedZatcaError (legacy ZatcaError -> tagged) · timeout & connection', () => {
  test('maps API_TIMEOUT to ZatcaTimeoutError preserving the message', () => {
    const legacy = new ZatcaError(
      'ZATCA API request timed out after 30000ms',
      ZatcaErrorCode.API_TIMEOUT,
    );

    const tagged = toTaggedZatcaError(legacy);

    expect(tagged._tag).toBe('ZatcaTimeoutError');
    expect(tagged).toBeInstanceOf(ZatcaTimeoutError);
    expect((tagged as ZatcaTimeoutError).message).toBe(
      'ZATCA API request timed out after 30000ms',
    );
  });

  test('maps API_CONNECTION_ERROR to ZatcaConnectionError extracting cause details', () => {
    const original = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED', syscall: 'connect', hostname: 'api.example.com' },
    });
    const legacy = new ZatcaError(
      'ZATCA API connection failed: fetch failed (ECONNREFUSED: connect api.example.com)',
      ZatcaErrorCode.API_CONNECTION_ERROR,
      original,
    );

    const tagged = toTaggedZatcaError(legacy) as ZatcaConnectionError;

    expect(tagged._tag).toBe('ZatcaConnectionError');
    expect(tagged.message).toBe(
      'ZATCA API connection failed: fetch failed (ECONNREFUSED: connect api.example.com)',
    );
    expect(tagged.causeCode).toBe('ECONNREFUSED');
    expect(tagged.syscall).toBe('connect');
    expect(tagged.hostname).toBe('api.example.com');
    expect(tagged.cause).toBe(original);
  });

  test('maps API_CONNECTION_ERROR without cause details', () => {
    const legacy = new ZatcaError(
      'ZATCA API connection failed: fetch failed',
      ZatcaErrorCode.API_CONNECTION_ERROR,
    );

    const tagged = toTaggedZatcaError(legacy) as ZatcaConnectionError;

    expect(tagged._tag).toBe('ZatcaConnectionError');
    expect(tagged.causeCode).toBeUndefined();
    expect(tagged.syscall).toBeUndefined();
    expect(tagged.hostname).toBeUndefined();
  });
});

describe('toTaggedZatcaError (legacy ZatcaError -> tagged) · validation & other codes', () => {
  test('maps VALIDATION_ERROR to ZatcaValidationError carrying the diagnostics', () => {
    const diagnostics = {
      error: { code: '2001', category: 'VAT', message: 'invalid vat' },
      warnings: [],
      alerts: [{ severity: 'error' as const, code: '2001', category: 'VAT', message: 'invalid vat' }],
    };
    const legacy = new ZatcaError(
      'Invoice validation failed',
      ZatcaErrorCode.VALIDATION_ERROR,
      diagnostics,
    );

    const tagged = toTaggedZatcaError(legacy) as ZatcaValidationError;

    expect(tagged._tag).toBe('ZatcaValidationError');
    expect(tagged.message).toBe('Invoice validation failed');
    expect(tagged.diagnostics).toEqual(diagnostics);
  });

  test('maps other codes to ZatcaApiError with the legacy code value', () => {
    const legacy = new ZatcaError('compliance failed', ZatcaErrorCode.API_ERROR);

    const tagged = toTaggedZatcaError(legacy) as ZatcaApiError;

    expect(tagged._tag).toBe('ZatcaApiError');
    expect(tagged.message).toBe('compliance failed');
    expect(tagged.code).toBe(ZatcaErrorCode.API_ERROR);
  });
});

describe('toZatcaError (tagged -> legacy ZatcaError)', () => {
  test('maps ZatcaConnectionError back preserving message, code and original cause identity', () => {
    const original = new Error('fetch failed');
    const tagged = new ZatcaConnectionError({
      message: 'ZATCA API connection failed: fetch failed (ECONNREFUSED: connect api.example.com)',
      causeCode: 'ECONNREFUSED',
      syscall: 'connect',
      hostname: 'api.example.com',
      cause: original,
    });

    const legacy = toZatcaError(tagged);

    expect(legacy).toBeInstanceOf(ZatcaError);
    expect(legacy.code).toBe(ZatcaErrorCode.API_CONNECTION_ERROR);
    expect(legacy.message).toBe(
      'ZATCA API connection failed: fetch failed (ECONNREFUSED: connect api.example.com)',
    );
    expect(legacy.details).toBe(original);
  });

  test('maps ZatcaTimeoutError back with API_TIMEOUT code', () => {
    const tagged = new ZatcaTimeoutError({
      message: 'ZATCA API request timed out after 30000ms',
    });

    const legacy = toZatcaError(tagged);

    expect(legacy.code).toBe(ZatcaErrorCode.API_TIMEOUT);
    expect(legacy.message).toBe('ZATCA API request timed out after 30000ms');
  });

  test('maps ZatcaValidationError back carrying diagnostics as details', () => {
    const diagnostics = { warnings: [], alerts: [] };
    const tagged = new ZatcaValidationError({
      message: 'validation failed',
      diagnostics,
    });

    const legacy = toZatcaError(tagged);

    expect(legacy.code).toBe(ZatcaErrorCode.VALIDATION_ERROR);
    expect(legacy.message).toBe('validation failed');
    expect(legacy.details).toEqual(diagnostics);
  });

  test('maps ZatcaApiError back keeping a known legacy code value', () => {
    const tagged = new ZatcaApiError({
      status: 500,
      body: 'upstream exploded',
      message: 'ZATCA API error (HTTP 500)',
      code: ZatcaErrorCode.API_ERROR,
    });

    const legacy = toZatcaError(tagged);

    expect(legacy.code).toBe(ZatcaErrorCode.API_ERROR);
    expect(legacy.message).toBe('ZATCA API error (HTTP 500)');
  });
});

describe('round trips', () => {
  test('connection error round trip keeps type, message and cause', () => {
    const original = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'gw.example.com' },
    });
    const legacy = new ZatcaError(
      'ZATCA API connection failed: fetch failed (ENOTFOUND: getaddrinfo gw.example.com)',
      ZatcaErrorCode.API_CONNECTION_ERROR,
      original,
    );

    const roundTripped = toZatcaError(toTaggedZatcaError(legacy));

    expect(roundTripped.code).toBe(legacy.code);
    expect(roundTripped.message).toBe(legacy.message);
    expect(roundTripped.details).toBe(original);
  });

  test('timeout error round trip keeps message and code', () => {
    const legacy = new ZatcaError('timed out', ZatcaErrorCode.API_TIMEOUT);
    const roundTripped = toZatcaError(toTaggedZatcaError(legacy));
    expect(roundTripped.code).toBe(legacy.code);
    expect(roundTripped.message).toBe(legacy.message);
  });

  test('isZatcaEffectError discriminates tagged errors from foreign errors', () => {
    expect(isZatcaEffectError(new ZatcaTimeoutError({ message: 'm' }))).toBe(true);
    expect(isZatcaEffectError(new ZatcaApiError({ status: 500, body: '', message: 'm', code: 'X' }))).toBe(true);
    expect(isZatcaEffectError(new Error('plain'))).toBe(false);
    expect(isZatcaEffectError(new ZatcaError('legacy', ZatcaErrorCode.API_ERROR))).toBe(false);
  });
});
